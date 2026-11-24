import express from 'express';
import cors from 'cors';
import { createHash, randomUUID } from 'node:crypto';
import { assessmentTypeSchema, requestSchema } from './contracts.js';
import { catalogs, RULES_VERSION } from './catalog.js';
import { createProvider, ServiceError } from './provider.js';
import { assess, ASSESSMENT_PROMPT_VERSION } from './assessment.js';
import { ANALYSIS_SNAPSHOT_VERSION, ASSESSMENT_CODE_VERSION } from './assessment-snapshot.js';
import { FACT_EXTRACTION_PROMPT_VERSION } from './prompts.js';
import { FACT_SCHEMA_VERSION, validateImage } from './facts.js';
import { legacyResponse } from './results.js';

const ANALYSIS_CACHE_SCOPE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function legacyInput(body) {
  const parts = body?.contents?.[0]?.parts;
  if (!Array.isArray(parts) || !parts.length) return body;
  const description = parts.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n');
  return { assessmentType: body.assessmentType || (description.includes('人体损伤致残程度分级') ? 'disability' : 'injury'),
    description, images: parts.filter(part => part?.inline_data).map(part => ({ mimeType: part.inline_data.mime_type || 'image/jpeg', data: part.inline_data.data, name: '' })) };
}

function validateImages(images) {
  for (const image of images) {
    const checked = validateImage(image);
    if (!checked.ok) throw new ServiceError(400, 'INVALID_IMAGE', `${checked.error}，请重新上传JPEG、PNG或WebP图片。`);
  }
}

export function createAnalysisCache({ ttlMs = 900_000, capacity = 200, now = Date.now, versions = {} } = {}) {
  const entries = new Map();
  const inFlight = new Map();
  let hits = 0;
  let misses = 0;
  const keyFor = (input, scope) => {
    const { forceReanalysis, ...cacheInput } = input;
    return createHash('sha256').update(JSON.stringify({ scope, versions, input: cacheInput }), 'utf8').digest('hex');
  };
  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) { entries.delete(key); return undefined; }
    entries.delete(key); entries.set(key, entry);
    return entry.value;
  }
  function set(key, value) {
    for (const [existingKey, entry] of entries) if (entry.expiresAt <= now()) entries.delete(existingKey);
    entries.delete(key); entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > capacity) entries.delete(entries.keys().next().value);
  }
  function subscribe(entry, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('Request aborted'));
    entry.subscribers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', abort);
        entry.subscribers -= 1;
        if (entry.subscribers === 0 && !entry.settled) {
          if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
          entry.controller.abort(new Error('No active analysis requests'));
        }
        return true;
      };
      const abort = () => {
        if (release()) reject(signal.reason || new Error('Request aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      entry.promise.then(value => { if (release()) resolve(value); }, error => { if (release()) reject(error); });
    });
  }
  async function run(input, requestId, produce, { signal, scope, onCache } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('Request aborted');
    if (ttlMs === 0 || capacity === 0 || typeof scope !== 'string' || !scope.trim() || scope.length > 128) {
      onCache?.(ttlMs === 0 || capacity === 0 ? 'disabled' : 'unscoped_bypass');
      misses += 1;
      return { ...(await produce(signal)), requestId };
    }
    const key = keyFor(input, scope);
    if (!input.forceReanalysis) {
      const cached = get(key);
      if (cached) { onCache?.('hit'); hits += 1; return { ...cached, requestId }; }
      const existing = inFlight.get(key);
      if (existing) {
        onCache?.('coalesced');
        hits += 1;
        return { ...(await subscribe(existing, signal)), requestId };
      }
    }
    onCache?.('miss');
    misses += 1;
    const controller = new AbortController();
    const entry = { key, controller, subscribers: 0, settled: false, promise: null };
    entry.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason || new Error('Request aborted');
      return produce(controller.signal);
    }).then(result => {
      entry.settled = true;
      if (entry.subscribers > 0) set(key, result);
      return result;
    }, error => {
      entry.settled = true;
      throw error;
    });
    if (!input.forceReanalysis) inFlight.set(key, entry);
    try {
      const result = await subscribe(entry, signal);
      return { ...result, requestId };
    } finally {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    }
  }
  function stats() {
    for (const [key, entry] of entries) if (entry.expiresAt <= now()) entries.delete(key);
    return { entries: entries.size, inFlight: inFlight.size, hits, misses };
  }
  return { run, stats };
}

export function createAnalysisRateLimiter({ windowMs = 60_000, maxRequests = 60, maxClients = 20_000, now = Date.now } = {}) {
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError('windowMs must be a positive integer');
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new RangeError('maxRequests must be a positive integer');
  if (!Number.isInteger(maxClients) || maxClients < 1) throw new RangeError('maxClients must be a positive integer');

  const clients = new Map();
  let requestsSinceCleanup = 0;
  return (req, res, next) => {
    const time = now();
    if (++requestsSinceCleanup >= 256) {
      for (const [ip, bucket] of clients) if (bucket.resetAt <= time) clients.delete(ip);
      requestsSinceCleanup = 0;
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = clients.get(ip);
    if (!bucket || bucket.resetAt <= time) bucket = { count: 0, resetAt: time + windowMs };
    bucket.count += 1;
    clients.delete(ip);
    clients.set(ip, bucket);
    while (clients.size > maxClients) clients.delete(clients.keys().next().value);

    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - time) / 1000));
    res.setHeader('RateLimit-Limit', String(maxRequests));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(retryAfter));
    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: '评估请求过于频繁，请稍后重试。', requestId: req.requestId } });
      return;
    }
    next();
  };
}

export function createAnalysisConcurrencyLimiter({ maxConcurrent = 4, maxGlobalConcurrent = 16 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be a positive integer');
  if (!Number.isInteger(maxGlobalConcurrent) || maxGlobalConcurrent < 1) throw new RangeError('maxGlobalConcurrent must be a positive integer');

  const activeByClient = new Map();
  let activeGlobal = 0;
  return async (clientIp, run) => {
    const ip = clientIp || 'unknown';
    const active = activeByClient.get(ip) || 0;
    if (active >= maxConcurrent || activeGlobal >= maxGlobalConcurrent) {
      throw new ServiceError(429, 'ANALYSIS_CONCURRENCY_LIMIT', '当前评估请求较多，请稍后重试。', { retryAfterSeconds: 1 });
    }

    activeByClient.set(ip, active + 1);
    activeGlobal += 1;
    try {
      return await run();
    } finally {
      activeGlobal -= 1;
      const remaining = (activeByClient.get(ip) || 1) - 1;
      if (remaining > 0) activeByClient.set(ip, remaining);
      else activeByClient.delete(ip);
    }
  };
}

export function createAnalysisBodyConcurrencyLimiter({ maxConcurrentPerIp = 2, maxConcurrentGlobal = 8,
  minContentLengthBytes = 262_144 } = {}) {
  for (const [name, value] of Object.entries({ maxConcurrentPerIp, maxConcurrentGlobal, minContentLengthBytes })) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }

  const activeByClient = new Map();
  let activeGlobal = 0;
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength < minContentLengthBytes) return next();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const active = activeByClient.get(ip) || 0;
    if (active >= maxConcurrentPerIp || activeGlobal >= maxConcurrentGlobal) {
      req.resume();
      res.setHeader('Retry-After', '1');
      res.setHeader('Connection', 'close');
      res.status(429).json({ error: { code: 'ANALYSIS_BODY_CONCURRENCY_LIMIT',
        message: '上传请求较多，请稍后重试。', requestId: req.requestId } });
      return;
    }
    activeByClient.set(ip, active + 1);
    activeGlobal += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeGlobal -= 1;
      const remaining = (activeByClient.get(ip) || 1) - 1;
      if (remaining > 0) activeByClient.set(ip, remaining);
      else activeByClient.delete(ip);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

function isLoopbackAddress(address = '') {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');
}

export function createApp(config, options = {}) {
  const app = express();
  const provider = options.provider || createProvider(config, options.fetchImpl);
  const cacheVersions = options.cacheVersions || {
    snapshot: ANALYSIS_SNAPSHOT_VERSION,
    code: config.codeVersion || process.env.APP_CODE_VERSION || process.env.GIT_COMMIT || ASSESSMENT_CODE_VERSION,
    codeHash: ASSESSMENT_CODE_VERSION,
    provider: config.provider || 'unknown', textModel: config.textModel, visionModel: config.visionModel,
    temperature: config.temperature ?? null, maxTokens: config.maxTokens ?? null,
    thinking: config.thinking ?? null, jsonMode: config.jsonMode ?? null,
    factSchema: FACT_SCHEMA_VERSION, factPrompt: FACT_EXTRACTION_PROMPT_VERSION,
    assessmentPrompt: ASSESSMENT_PROMPT_VERSION, rules: RULES_VERSION,
  };
  const analysisCache = options.analysisCache || createAnalysisCache({
    ttlMs: config.cacheTtlMs ?? 900_000, capacity: config.cacheCapacity ?? 200, now: options.now || Date.now,
    versions: cacheVersions,
  });
  const analysisRateLimiter = createAnalysisRateLimiter(options.analysisRateLimit || {
    windowMs: config.analysisRateLimitWindowMs,
    maxRequests: config.analysisRateLimitMaxRequests,
  });
  const analysisConcurrencyLimiter = createAnalysisConcurrencyLimiter(options.analysisConcurrencyLimit || {
    maxConcurrent: config.analysisConcurrencyPerIp,
    maxGlobalConcurrent: config.analysisConcurrencyGlobal,
  });
  const analysisBodyConcurrencyLimiter = createAnalysisBodyConcurrencyLimiter(options.analysisBodyConcurrencyLimit || {
    maxConcurrentPerIp: config.analysisBodyConcurrencyPerIp,
    maxConcurrentGlobal: config.analysisBodyConcurrencyGlobal,
    minContentLengthBytes: config.analysisBodyConcurrencyThresholdBytes,
  });
  app.disable('x-powered-by');
  // Nginx connects over loopback; only that trusted hop may supply the client IP.
  app.set('trust proxy', 'loopback');
  const allowedOrigins = new Set(config.corsAllowedOrigins || [
    'https://analyst.lintsing.net', 'https://appraise.lintsing.net',
    'http://127.0.0.1:5300', 'http://localhost:5300',
  ]);
  app.use(cors({ origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  } }));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/analyze', (req, res, next) => req.method === 'POST'
    ? analysisRateLimiter(req, res, () => analysisBodyConcurrencyLimiter(req, res, next)) : next());
  app.use(express.json({ limit: '50mb', inflate: false }));
  app.get('/', (req, res) => res.send('Assessment API is Running!'));
  app.get('/api/health/live', (req, res) => res.json({ status: 'ok', version: 2 }));
  app.get('/api/health/ready', async (req, res) => {
    const health = await provider.readiness();
    res.status(health.status === 'ready' ? 200 : 503).json(health);
  });
  app.get('/api/cache/stats', (req, res) => {
    if (!isLoopbackAddress(req.ip || req.socket.remoteAddress || '')) return res.sendStatus(404);
    res.json(analysisCache.stats());
  });
  app.get('/api/standards/:type', (req, res) => {
    const kind = assessmentTypeSchema.safeParse(req.params.type);
    if (!kind.success) throw new ServiceError(404, 'STANDARD_NOT_FOUND', '未找到该评估类型的标准。');
    res.json(catalogs[kind.data]);
  });
  app.post('/api/analyze', async (req, res, next) => {
    const started = Date.now();
    const modelMetrics = { requests: 0, completed: 0, failed: 0, inputTokens: 0, outputTokens: 0,
      tokenReports: 0, providerLatencyMs: 0, providerReportedCost: 0, costReports: 0 };
    let cacheDisposition = 'unscoped_bypass';
    const recordModelMetrics = event => {
      if (event.type === 'request_start') modelMetrics.requests += 1;
      if (event.type !== 'request_end') return;
      modelMetrics.providerLatencyMs += event.durationMs || 0;
      if (event.failed) modelMetrics.failed += 1;
      else modelMetrics.completed += 1;
      if (Number.isFinite(event.inputTokens) && Number.isFinite(event.outputTokens)) {
        modelMetrics.inputTokens += event.inputTokens;
        modelMetrics.outputTokens += event.outputTokens;
        modelMetrics.tokenReports += 1;
      }
      if (Number.isFinite(event.providerCost)) {
        modelMetrics.providerReportedCost += event.providerCost;
        modelMetrics.costReports += 1;
      }
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new ServiceError(504, 'ANALYSIS_TIMEOUT', '本次分析超时，未生成结论，请稍后重试或精简材料。')), config.timeoutMs);
    const disconnected = () => { if (!res.writableEnded) controller.abort(new ServiceError(499, 'CLIENT_CANCELLED', '本次分析已取消。')); };
    res.on('close', disconnected);
    try {
      const parsed = requestSchema.safeParse(legacyInput(req.body));
      if (!parsed.success) throw new ServiceError(400, 'INVALID_REQUEST', parsed.error.issues[0].message);
      validateImages(parsed.data.images);
      const cacheScopeHeader = req.get('x-analysis-cache-scope') || '';
      const cacheScope = ANALYSIS_CACHE_SCOPE_PATTERN.test(cacheScopeHeader) ? cacheScopeHeader : null;
      const result = await analysisCache.run(parsed.data, req.requestId,
        signal => analysisConcurrencyLimiter(req.ip || req.socket.remoteAddress,
          () => assess(parsed.data, { provider, config, signal, requestId: req.requestId, onMetrics: recordModelMetrics })),
        { signal: controller.signal, scope: cacheScope, onCache: value => { cacheDisposition = value; } });
      if (!res.destroyed) res.json({ result, candidates: [{ content: { parts: [{ text: JSON.stringify(legacyResponse(result)) }] } }] });
    } catch (error) {
      if (!res.destroyed) next(controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      clearTimeout(timeout);
      res.off('close', disconnected);
      console.log(JSON.stringify({ event: 'analysis', requestId: req.requestId, durationMs: Date.now() - started,
        status: controller.signal.aborted && res.destroyed ? 499 : res.statusCode, cancelled: controller.signal.aborted,
        cache: cacheDisposition, ...modelMetrics, providerReportedCost: modelMetrics.costReports > 0
          ? modelMetrics.providerReportedCost : null,
        tokenUsageComplete: modelMetrics.requests > 0 && modelMetrics.failed === 0
          && modelMetrics.completed === modelMetrics.tokenReports }));
    }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const known = error instanceof ServiceError;
    const malformed = error.type === 'entity.parse.failed';
    const tooLarge = error.type === 'entity.too.large';
    const uploadAborted = error.type === 'request.aborted';
    const unsupported = ['encoding.unsupported', 'charset.unsupported'].includes(error.type);
    const status = known ? error.status : malformed || uploadAborted ? 400 : tooLarge ? 413 : unsupported ? 415 : 500;
    const code = known ? error.code : malformed ? 'INVALID_JSON' : tooLarge ? 'PAYLOAD_TOO_LARGE' : uploadAborted ? 'UPLOAD_INTERRUPTED' : unsupported ? 'UNSUPPORTED_ENCODING' : 'INTERNAL_ERROR';
    console.error(JSON.stringify({ event: 'error', requestId: req.requestId, code, status,
      upstreamStatus: known ? error.upstreamStatus : undefined,
      retryAfterSeconds: known ? error.retryAfterSeconds : undefined,
      method: req.method, route: req.route?.path || 'unmatched', errorType: error.type || error.name || 'Error',
      ...(config.localHttp && error instanceof Error ? { diagnostic: { message: error.message, stack: error.stack } } : {}) }));
    if (res.destroyed) return;
    if (known && Number.isFinite(error.retryAfterSeconds)) res.setHeader('Retry-After', String(Math.ceil(error.retryAfterSeconds)));
    res.status(status).json({ error: { code, message: known ? error.message : malformed ? '请求内容不是有效JSON。' : tooLarge ? '提交材料过大，请压缩图片或分批上传。' : uploadAborted ? '材料上传已中断，请检查网络后重新提交。' : unsupported ? '请求编码不受支持，请重新提交材料。' : '分析服务暂时异常，请稍后重试。', requestId: req.requestId } });
  });
  return app;
}
