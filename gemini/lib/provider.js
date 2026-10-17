import { z } from 'zod';
import { normalizeFactExtractionResponse } from './facts.js';

export class ServiceError extends Error {
  constructor(status, code, message, metadata = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstreamStatus = metadata.upstreamStatus;
    this.retryAfterSeconds = metadata.retryAfterSeconds;
  }
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}

function waitForRetry(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('Request aborted'));
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason || new Error('Request aborted'));
    };
    const timer = setTimeout(() => { finish(); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createProvider(config, fetchImpl = fetch, waitImpl = waitForRetry) {
  async function complete({ model, schema, name, messages, signal, repair = false }) {
    const jsonSchema = z.toJSONSchema(schema);
    const format = config.jsonMode === 'object' ? { type: 'json_object' } : {
      type: 'json_schema', json_schema: { name, strict: true, schema: jsonSchema },
    };
    const formatInstruction = `只输出符合以下JSON Schema的完整JSON对象：${JSON.stringify(jsonSchema)}`;
    const instructedMessages = messages[0]?.role === 'system'
      ? [{ ...messages[0], content: `${formatInstruction}\n\n${messages[0].content}` }, ...messages.slice(1)]
      : [{ role: 'system', content: formatInstruction }, ...messages];
    const payload = { model, messages: instructedMessages, response_format: format, max_tokens: config.maxTokens };
    if (/^kimi-k2\.[56]$/.test(model)) {
      payload.thinking = { type: config.thinking };
      if (Number.isFinite(config.temperature)) payload.temperature = config.temperature;
    }
    const init = { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(payload), signal };
    let response;
    let attempts = 0;
    while (true) {
      try { response = await fetchImpl(config.apiUrl, init); } catch {
        if (signal?.aborted) throw signal.reason;
        throw new ServiceError(502, 'UPSTREAM_CONNECTION', '暂时无法连接分析服务，请稍后重试。');
      }
      if (response.status !== 429) break;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      if (attempts === 0 && retryAfter !== null && retryAfter <= 2) {
        attempts += 1;
        await waitImpl(retryAfter * 1000, signal);
        continue;
      }
      response.body?.cancel().catch(() => {});
      throw new ServiceError(503, 'UPSTREAM_RATE_LIMIT', '分析请求触发上游限流，请稍后重试。', {
        upstreamStatus: response.status, retryAfterSeconds: retryAfter,
      });
    }
    if (!response.ok) {
      const status = response.status;
      response.body?.cancel().catch(() => {});
      const metadata = { upstreamStatus: status };
      if (status === 404) throw new ServiceError(503, 'MODEL_UNAVAILABLE', '当前分析模型不可用，请联系管理员检查模型配置。', metadata);
      if (status === 401 || status === 403) throw new ServiceError(503, 'PROVIDER_CONFIGURATION', '分析服务的账户配置异常，请联系管理员。', metadata);
      if (status >= 500) throw new ServiceError(503, 'UPSTREAM_FAILURE', '分析服务上游暂时不可用，请稍后重试。', metadata);
      throw new ServiceError(502, 'UPSTREAM_REJECTED', '分析服务未接受本次材料，请检查图片和描述后重试。', metadata);
    }
    let body;
    try { body = await response.json(); } catch {
      if (signal?.aborted) throw signal.reason;
      throw new ServiceError(502, 'UPSTREAM_FORMAT', '分析服务返回了无法识别的响应，请稍后重试。');
    }
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') throw new ServiceError(502, 'OUTPUT_TRUNCATED', '分析回复未完成，请精简材料或分批上传报告后重试。');
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new ServiceError(502, 'EMPTY_RESULT', '未收到完整的分析结果，请重试。');
    try {
      let value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (name === 'fact_extraction') value = normalizeFactExtractionResponse(value);
      return schema.parse(value);
    } catch {
      if (!repair) return complete({ model, schema, name, signal, repair: true, messages: [
        ...messages, { role: 'assistant', content },
        { role: 'user', content: '刚才的回复未通过JSON结构校验。请只修正JSON格式与字段类型，输出完整对象，不得增加材料中没有的事实。所有必填字段必须存在，未知项使用空数组或null。' },
      ] });
      throw new ServiceError(502, 'INVALID_RESULT', '分析结果未通过格式校验，未生成评估结论，请重试。');
    }
  }
  let readinessCache;
  async function readiness() {
    if (readinessCache && Date.now() - readinessCache.at < 300000) return readinessCache.value;
    const url = new URL(config.apiUrl);
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/models');
    try {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      const models = new Set(body.data?.map(model => model.id) || []);
      const ok = response.ok && models.has(config.textModel) && models.has(config.visionModel);
      const value = { status: ok ? 'ready' : 'unavailable', configuredModelsAvailable: ok };
      readinessCache = { at: Date.now(), value };
      return value;
    } catch { return { status: 'unavailable', configuredModelsAvailable: false }; }
  }
  return { complete, readiness };
}
