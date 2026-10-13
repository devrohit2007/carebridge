// AI provider adapters. One small interface, three wire formats, all configured via environment variables.
// Nothing here logs prompts or document text.

export class AiError extends Error {
  constructor(message, { status = 0, code = 'ai_error', retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

/** Pull a JSON object out of a model reply (tolerates code fences, preambles, trailing commas). */
export function extractJson(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('The model did not return JSON.', { code: 'invalid_json' });
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    /* try a light repair below */
  }
  try {
    return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    throw new AiError('The model returned malformed JSON.', { code: 'invalid_json' });
  }
}

function errorMessage(data, raw, status) {
  const m = data?.error?.message || data?.message || data?.error || raw;
  return `Provider returned HTTP ${status}: ${clip(typeof m === 'string' ? m : JSON.stringify(m))}`;
}

async function postJson(url, headers, body, { timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      throw new AiError(errorMessage(data, raw, res.status), {
        status: res.status,
        code: res.status === 429 ? 'rate_limited' : res.status === 401 || res.status === 403 ? 'auth' : 'http_error',
        retryable: [408, 425, 429, 500, 502, 503, 504].includes(res.status),
      });
    }
    if (!data) throw new AiError('Provider returned a non-JSON response.', { code: 'bad_response' });
    return data;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e?.name === 'AbortError') throw new AiError('The AI request timed out.', { code: 'timeout', retryable: true });
    throw new AiError(`Network error talking to the AI provider: ${clip(e?.message, 120)}`, { code: 'network', retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// ---- wire formats -------------------------------------------------------

// Newer Gemini models \"think\" before answering, which can add many seconds. Reading documents does not need it.
// Model generations name the setting differently, so try the least-thinking variants in order and remember what worked.
const THINKING_VARIANTS = [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }, null];
const thinkingChoice = new Map(); // model -> index into THINKING_VARIANTS that the API accepted

async function callGemini(cfg, { system, user, image, json }, io) {
  const { model, baseUrl, apiKey, maxOutputTokens } = cfg.ai;
  const parts = [{ text: user }];
  if (image) parts.unshift({ inlineData: { mimeType: image.mime, data: image.data } });
  const build = (thinking) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens, ...(json ? { responseMimeType: 'application/json' } : {}), ...(thinking ? { thinkingConfig: thinking } : {}) },
  });
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let data;
  if (cfg.ai.thinking === 'default') {
    data = await postJson(url, { 'x-goog-api-key': apiKey }, build(null), io);
  } else {
    for (let i = thinkingChoice.get(model) ?? 0; i < THINKING_VARIANTS.length; i++) {
      try {
        data = await postJson(url, { 'x-goog-api-key': apiKey }, build(THINKING_VARIANTS[i]), io);
        thinkingChoice.set(model, i);
        break;
      } catch (e) {
        const last = i === THINKING_VARIANTS.length - 1;
        if (last || !(e instanceof AiError) || e.status !== 400 || !/think/i.test(e.message)) throw e; // not about thinking: a real error
      }
    }
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    const why = data.promptFeedback?.blockReason;
    throw new AiError(why ? `The request was blocked by the provider (${why}).` : 'The provider returned no answer.', { code: 'blocked' });
  }
  if (cand.finishReason === 'MAX_TOKENS') throw new AiError('The answer was cut off (too long). Try fewer documents.', { code: 'truncated' });
  const text = (cand.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  if (!text.trim()) throw new AiError('The provider returned an empty answer.', { code: 'empty' });
  return text;
}

async function callOpenAi(cfg, { system, user, image, json }, io) {
  const { model, baseUrl, apiKey, maxOutputTokens } = cfg.ai;
  const content = image
    ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }]
    : user;
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    temperature: 0.1,
    max_tokens: maxOutputTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  // Providers disagree about some optional fields; adapt once or twice instead of failing.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await postJson(`${baseUrl}/chat/completions`, { authorization: `Bearer ${apiKey}` }, body, io);
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new AiError('The answer was cut off (too long). Try fewer documents.', { code: 'truncated' });
      const text = choice?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new AiError('The provider returned an empty answer.', { code: 'empty' });
      return text;
    } catch (e) {
      if (!(e instanceof AiError) || e.status !== 400 || attempt === 2) throw e;
      const msg = e.message.toLowerCase();
      if (body.response_format && /response_format|json/.test(msg)) delete body.response_format;
      else if ('max_tokens' in body && /max_tokens|max_completion_tokens/.test(msg)) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      } else if ('temperature' in body && /temperature/.test(msg)) delete body.temperature;
      else throw e;
    }
  }
  throw new AiError('Unexpected provider failure.');
}

async function callAnthropic(cfg, { system, user, image }, io) {
  const { model, baseUrl, apiKey, maxOutputTokens } = cfg.ai;
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }, { type: 'text', text: user }]
    : user;
  const data = await postJson(
    `${baseUrl}/v1/messages`,
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: maxOutputTokens, temperature: 0.1, system, messages: [{ role: 'user', content }] },
    io,
  );
  if (data.stop_reason === 'max_tokens') throw new AiError('The answer was cut off (too long). Try fewer documents.', { code: 'truncated' });
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text.trim()) throw new AiError('The provider returned an empty answer.', { code: 'empty' });
  return text;
}

const ADAPTERS = { gemini: callGemini, openai: callOpenAi, anthropic: callAnthropic };

/**
 * Send one prompt, get text back. Retries once on transient errors (rate limit / overload / network).
 * `retryDelayMs` is injectable so tests do not wait.
 */
export async function callModel(cfg, prompt, { fetchImpl = globalThis.fetch, retryDelayMs = 2000 } = {}) {
  const adapter = ADAPTERS[cfg.ai.provider];
  if (!adapter) throw new AiError('No AI provider configured.', { code: 'not_configured' });
  const io = { timeoutMs: cfg.ai.timeoutMs, fetchImpl };
  try {
    return await adapter(cfg, { json: true, ...prompt }, io);
  } catch (e) {
    if (e instanceof AiError && e.retryable) {
      await sleep(retryDelayMs);
      return adapter(cfg, { json: true, ...prompt }, io);
    }
    throw e;
  }
}

/** Ask for JSON; if the reply is not parseable, ask once more. */
export async function callJson(cfg, { system, user }, opts) {
  const text = await callModel(cfg, { system, user, json: true }, opts);
  try {
    return extractJson(text);
  } catch {
    const again = await callModel(
      cfg,
      { system, user: `${user}\n\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object: no commentary, no code fences.`, json: true },
      opts,
    );
    return extractJson(again);
  }
}

/** Plain-text answer (used for image transcription). */
export function callText(cfg, { system, user, image }, opts) {
  return callModel(cfg, { system, user, image, json: false }, opts);
}

/** List model ids the configured key can use (for `npm run models`). */
export async function listModels(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const { provider, baseUrl, apiKey } = cfg.ai;
  const get = async (url, headers) => {
    const res = await fetchImpl(url, { headers });
    const raw = await res.text();
    if (!res.ok) throw new AiError(errorMessage(null, raw, res.status), { status: res.status });
    return JSON.parse(raw);
  };
  if (provider === 'gemini') {
    const d = await get(`${baseUrl}/v1beta/models?pageSize=200`, { 'x-goog-api-key': apiKey });
    return (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''));
  }
  if (provider === 'openai') {
    const d = await get(`${baseUrl}/models`, { authorization: `Bearer ${apiKey}` });
    return (d.data || []).map((m) => m.id);
  }
  if (provider === 'anthropic') {
    const d = await get(`${baseUrl}/v1/models`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
    return (d.data || []).map((m) => m.id);
  }
  throw new AiError('No AI provider configured.', { code: 'not_configured' });
}
