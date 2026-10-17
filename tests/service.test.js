import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAnalysisCache, createApp } from '../gemini/lib/app.js';
import { createProvider, ServiceError } from '../gemini/lib/provider.js';
import { factExtractionSchema, providerResultSchema } from '../gemini/lib/contracts.js';
import { inputs, providerFixture } from './fixtures.js';

const config = { apiKey: 'test-key', apiUrl: 'https://example.test/v1/chat/completions',
  textModel: 'test-text', visionModel: 'test-vision', timeoutMs: 200,
  maxTokens: 10000, thinking: 'disabled', jsonMode: 'schema' };

async function withApp(options, run, overrides = {}) {
  const server = createApp({ ...config, ...overrides }, options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const provider = { complete: async request => request.name === 'fact_extraction'
  ? { facts: [], missingMaterials: [], conflicts: [], requiresReview: false }
  : providerFixture(), readiness: async () => ({ status: 'ready', configuredModelsAvailable: true }) };
const post = (url, input, signal) => fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });

test('analysis returns validated result and legacy envelope; live and ready are separate', async () => {
  const evidence = 'CT报告明确记载左侧第3、4肋骨骨折，共2处骨折，均为本次外伤导致，无既往损伤。';
  const source = 'CT报告明确记载左侧第3、4肋骨骨折';
  const assessmentProvider = { ...provider, complete: async request => request.name === 'fact_extraction'
    ? { facts: [
      { id: 'F1', field: 'injury_type', value: 'rib_fracture', certainty: 'reported', source: 'description', evidence: source, eventId: 'E1' },
      { id: 'F2', field: 'fracture_site_count', value: 2, certainty: 'reported', source: 'description', evidence: '共2处骨折', eventId: 'E1' },
    ], missingMaterials: [], conflicts: [], requiresReview: false }
    : providerFixture() };
  assert.equal(inputs.injury.description, evidence);
  await withApp({ provider: assessmentProvider }, async url => {
    const response = await post(url, inputs.injury); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.result.grade, '轻伤二级');
    assert.equal(JSON.parse(body.candidates[0].content.parts[0].text).grade, '轻伤二级');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-request-id'));
    assert.equal((await fetch(url + '/api/health/live')).status, 200);
    assert.equal((await fetch(url + '/api/health/ready')).status, 200);
    assert.equal((await fetch(url + '/api/standards/disability')).status, 200);
  });
});

test('valid legacy contents requests remain compatible and preserve the uploaded MIME type', async () => {
  const png = Buffer.alloc(45);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
  png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20); png.write('IEND', 37, 'ascii'); png[44] = 0x82;
  const calls = [];
  const provider = { readiness: async () => ({ status: 'ready', configuredModelsAvailable: true }), async complete(request) {
    calls.push(request.name);
    if (request.name === 'medical_report_transcription') return { pages: [{ imageIndex: 1, text: '成年人脾部分切除术后', issues: [] }] };
    if (request.name === 'fact_extraction') return { facts: [], missingMaterials: [], conflicts: [], requiresReview: false };
    return { ...providerFixture('disability'), facts: [] };
  } };
  await withApp({ provider }, async url => {
    const response = await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { text: '请依据《人体损伤致残程度分级》分析。成年人脾部分切除术后。' },
        { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
      ] }] }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.assessmentType, 'disability');
    assert.deepEqual(calls, ['medical_report_transcription', 'fact_extraction', 'assessment_result']);
  });
});

test('invalid body, MIME mismatch and malformed JSON return structured errors', async () => {
  await withApp({ provider }, async url => {
    assert.equal((await post(url, { contents: [{ parts: {} }] })).status, 400);
    const image = await post(url, { ...inputs.injury, images: [{ mimeType: 'image/jpeg', data: 'aGVsbG8=' }] });
    assert.equal(image.status, 400); assert.equal((await image.json()).error.code, 'INVALID_IMAGE');
    const malformed = await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
    const encoding = await fetch(url + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'not-supported' }, body: JSON.stringify(inputs.injury) });
    assert.equal(encoding.status, 415); assert.equal((await encoding.json()).error.code, 'UNSUPPORTED_ENCODING');
  });
});

test('truncated but correctly signed image bytes are rejected before model calls', async () => {
  let calls = 0;
  const provider = { ...providerFixture, complete: async request => {
    calls += 1;
    return request.name === 'fact_extraction'
      ? { facts: [], missingMaterials: [], conflicts: [], requiresReview: false }
      : providerFixture();
  } };
  await withApp({ provider }, async url => {
    const truncated = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const response = await post(url, { ...inputs.injury, images: [{ name: 'truncated.png', mimeType: 'image/png', data: truncated }] });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_IMAGE');
    assert.equal(calls, 0);
  });
});

test('provider failure produces an error without fabricated candidates or a saved result', async () => {
  await withApp({ provider: { ...provider, complete: async () => { throw new ServiceError(503, 'MODEL_UNAVAILABLE', '模型不可用'); } } }, async url => {
    const response = await post(url, inputs.injury); assert.equal(response.status, 503);
    const body = await response.json(); assert.equal(body.error.code, 'MODEL_UNAVAILABLE');
    assert.equal(body.result, undefined); assert.equal(body.candidates, undefined);
  });
});

test('deadline aborts the provider and returns no assessment conclusion', async () => {
  const pending = { ...provider, complete: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  await withApp({ provider: pending }, async url => {
    const response = await post(url, inputs.injury);
    assert.equal(response.status, 504); assert.equal((await response.json()).error.code, 'ANALYSIS_TIMEOUT');
  }, { timeoutMs: 30 });
});

test('client cancellation reaches the provider instead of letting the analysis continue', async () => {
  let interrupted;
  const aborted = new Promise(resolve => { interrupted = resolve; });
  const pending = { ...provider, complete: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { interrupted(true); reject(signal.reason); }, { once: true })) };
  await withApp({ provider: pending }, async url => {
    const controller = new AbortController();
    const request = post(url, inputs.injury, controller.signal).catch(() => null);
    setTimeout(() => controller.abort(), 40);
    assert.equal(await Promise.race([aborted, new Promise(resolve => setTimeout(() => resolve(false), 500))]), true);
    await request;
  }, { timeoutMs: 1000 });
});

test('readiness checks configured model access, not just a running process', async () => {
  await withApp({ provider: { ...provider, readiness: async () => ({ status: 'unavailable', configuredModelsAvailable: false }) } }, async url => {
    assert.equal((await fetch(url + '/api/health/live')).status, 200);
    assert.equal((await fetch(url + '/api/health/ready')).status, 503);
  });
});

test('JSON repair is bounded and invalid results never become an apparent success', async () => {
  let count = 0;
  const mocked = createProvider(config, async () => {
    count++;
    return Response.json({ choices: [{ message: { content: '{invalid' }, finish_reason: 'stop' }] });
  });
  await assert.rejects(mocked.complete({ model: 'test-text', schema: providerResultSchema, name: 'result', messages: [], signal: new AbortController().signal }), error => error.code === 'INVALID_RESULT');
  assert.equal(count, 2);
});

test('provider adapts both observed Kimi conflict-object shapes into the strict fact schema', async () => {
  const shapes = [
    { between: ['F1', 'F2'], description: '疑似骨折与复查未见骨折' },
    { fact_ids: ['F1', 'F2'], description: '疑似骨折与复查未见骨折' },
  ];
  for (const conflict of shapes) {
    const content = JSON.stringify({
      facts: [
        { id: 'F1', field: 'rib_fracture', value: 'suspected', certainty: 'uncertain', source_type: 'medical_record', source_excerpt: '疑似第六肋骨骨折' },
        { id: 'F2', field: 'rib_fracture', value: 'excluded', certainty: 'excluded', source_type: 'medical_record', source_excerpt: '复查报告未见骨折' },
      ], missing_information: [], conflicts: [conflict], requires_review: true,
    });
    let payload;
    const mocked = createProvider({ ...config, temperature: 0.6 }, async (_url, init) => {
      payload = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    });
    const result = await mocked.complete({ model: 'kimi-k2.6', schema: factExtractionSchema,
      name: 'fact_extraction', messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'synthetic input' }] });
    assert.deepEqual(result.conflicts, [{ factIds: ['F1', 'F2'], reason: conflict.description }]);
    assert.equal(result.facts[0].source, 'description');
    assert.equal(payload.response_format.type, 'json_schema');
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.equal(payload.temperature, 0.6);
  }
});

test('upstream status errors never expose provider response bodies', async () => {
  const cases = [[401, 'PROVIDER_CONFIGURATION'], [403, 'PROVIDER_CONFIGURATION'], [404, 'MODEL_UNAVAILABLE'], [429, 'UPSTREAM_RATE_LIMIT'], [503, 'UPSTREAM_FAILURE']];
  for (const [status, code] of cases) {
    const mocked = createProvider(config, async () => Response.json({ error: { message: 'upstream secret payload' } }, { status }));
    await assert.rejects(mocked.complete({ model: 'kimi-k2.6', schema: providerResultSchema, name: 'assessment_result', messages: [] }), error => {
      assert.equal(error.code, code); assert.equal(error.message.includes('secret'), false); return true;
    });
  }
});

test('provider retries one 429 after the upstream one-second Retry-After and returns the result', async () => {
  let calls = 0;
  const waits = [];
  const completion = { status: 'preliminary', grade: null, summary: 's', reasoning: 'r', facts: [],
    references: [], missingMaterials: [], nextSteps: [], warnings: [] };
  const mocked = createProvider(config, async () => {
    calls += 1;
    if (calls === 1) return new Response('throttled', { status: 429, headers: { 'Retry-After': '1' } });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(completion) } }] });
  }, async milliseconds => { waits.push(milliseconds); });

  const result = await mocked.complete({ model: 'kimi-k2.6', schema: providerResultSchema,
    name: 'assessment_result', messages: [] });

  assert.equal(result.grade, null);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test('provider does not retry 429 without a short Retry-After or retry 5xx', async () => {
  for (const [status, headers, code] of [
    [429, {}, 'UPSTREAM_RATE_LIMIT'],
    [429, { 'Retry-After': '3' }, 'UPSTREAM_RATE_LIMIT'],
    [503, { 'Retry-After': '1' }, 'UPSTREAM_FAILURE'],
  ]) {
    let calls = 0;
    const mocked = createProvider(config, async () => {
      calls += 1;
      return new Response('upstream secret payload', { status, headers });
    }, async () => assert.fail('unexpected retry delay'));

    await assert.rejects(mocked.complete({ model: 'kimi-k2.6', schema: providerResultSchema,
      name: 'assessment_result', messages: [] }), error => {
      assert.equal(error.code, code);
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('provider retries a short 429 at most once and preserves the final upstream status', async () => {
  let calls = 0;
  const mocked = createProvider(config, async () => {
    calls += 1;
    return new Response('upstream secret payload', { status: 429, headers: { 'Retry-After': '0' } });
  }, async () => {});

  await assert.rejects(mocked.complete({ model: 'kimi-k2.6', schema: providerResultSchema,
    name: 'assessment_result', messages: [] }), error => {
    assert.equal(error.code, 'UPSTREAM_RATE_LIMIT');
    assert.equal(error.upstreamStatus, 429);
    assert.equal(error.retryAfterSeconds, 0);
    return true;
  });
  assert.equal(calls, 2);
});

test('ordinary identical requests reuse validated results; forceReanalysis bypasses the cache', async () => {
  const calls = [];
  const provider = { async complete(request) {
    calls.push(request.name);
    return request.name === 'fact_extraction'
      ? { facts: [], missingMaterials: [], conflicts: [], requiresReview: false }
      : { ...providerFixture('injury'), facts: [] };
  } };
  await withApp({ provider }, async url => {
    const first = await post(url, inputs.injury); assert.equal(first.status, 200);
    const firstBody = await first.json();
    const repeated = await post(url, inputs.injury); assert.equal(repeated.status, 200);
    const repeatedBody = await repeated.json();
    assert.deepEqual(calls, ['fact_extraction', 'assessment_result']);
    assert.equal(firstBody.result.grade, repeatedBody.result.grade);
    assert.equal(firstBody.result.status, repeatedBody.result.status);
    assert.notEqual(firstBody.result.requestId, repeatedBody.result.requestId);
    const forced = await post(url, { ...inputs.injury, forceReanalysis: true }); assert.equal(forced.status, 200);
    assert.deepEqual(calls, ['fact_extraction', 'assessment_result', 'fact_extraction', 'assessment_result']);
  });
});

test('twenty concurrent identical requests share one fact and assessment run', async () => {
  const calls = [];
  const provider = { async complete(request) {
    calls.push(request.name);
    await new Promise(resolve => setTimeout(resolve, 10));
    return request.name === 'fact_extraction'
      ? { facts: [], missingMaterials: [], conflicts: [], requiresReview: false }
      : { ...providerFixture('injury'), facts: [] };
  } };
  await withApp({ provider }, async url => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(url, inputs.injury)));
    assert.ok(responses.every(response => response.status === 200));
    const results = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(calls, ['fact_extraction', 'assessment_result']);
    assert.equal(new Set(results.map(item => item.result.grade)).size, 1);
    assert.equal(new Set(results.map(item => item.result.requestId)).size, 20);
  });
});

test('analysis cache expires entries and enforces its bounded capacity', async () => {
  let now = 100;
  const cache = createAnalysisCache({ ttlMs: 10, capacity: 1, now: () => now });
  let calls = 0;
  const producer = async () => ({ value: ++calls });
  assert.deepEqual(await cache.run({ description: 'A' }, 'r1', producer), { value: 1, requestId: 'r1' });
  assert.deepEqual(await cache.run({ description: 'A' }, 'r2', producer), { value: 1, requestId: 'r2' });
  assert.equal(calls, 1);
  await cache.run({ description: 'B' }, 'r3', producer);
  assert.equal(cache.stats().entries, 1);
  await cache.run({ description: 'A' }, 'r4', producer);
  assert.equal(calls, 3);
  now += 11;
  await cache.run({ description: 'A' }, 'r5', producer);
  assert.equal(calls, 4);
});

test('truncated upstream output is rejected even if a partial JSON value happens to parse', async () => {
  const mocked = createProvider(config, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(providerFixture()) } }] }));
  await assert.rejects(mocked.complete({ model: 'test-text', schema: providerResultSchema, name: 'result', messages: [] }), error => error.code === 'OUTPUT_TRUNCATED');
});
