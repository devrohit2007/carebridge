// Orchestration: validate input -> (AI and/or rules) extraction -> verified analysis.
import { buildAnalysis, mergeRaw } from './build.js';
import { ApiError } from './errors.js';
import { runMissing } from './missing.js';
import { cleanText, resolveToday } from './normalize.js';
import { extractionPrompt, transcribePrompt } from './prompts.js';
import { AiError, callJson, callText } from './providers.js';
import { rulesExtract } from './rules.js';
import { coerceRaw, sanitizeAnalysisIn, sanitizeDocs } from './schema.js';

export function friendlyAiError(e) {
  if (!(e instanceof AiError)) return 'The AI service failed unexpectedly.';
  switch (e.code) {
    case 'auth': return 'The AI service rejected the API key. Check AI_API_KEY.';
    case 'rate_limited': return 'The AI service is busy or over its free limit. Try again in a minute.';
    case 'timeout': return 'The AI service took too long to answer.';
    case 'network': return 'The AI service could not be reached.';
    case 'truncated': return 'The AI answer was too long to finish. Try fewer or shorter documents.';
    case 'invalid_json': return 'The AI service returned an answer CareBridge could not read.';
    case 'blocked': return 'The AI service declined to process this content.';
    default: return 'The AI service returned an error.';
  }
}

export async function analyzeDocuments(input, cfg, opts = {}) {
  const docs = sanitizeDocs(input?.documents, cfg.limits);
  const now = opts.now || new Date();
  const today = resolveToday(input?.today, now);
  const rules = coerceRaw(rulesExtract(docs));
  let raw = rules;
  let mode = 'rules';
  let notice = null;
  if (cfg.ai.provider !== 'none' && input?.aiMode !== 'off') { // aiMode 'off' = instant built-in results (the app then upgrades with AI)
    try {
      const ai = coerceRaw(await callJson(cfg, extractionPrompt(docs), opts));
      raw = mergeRaw(ai, rules);
      mode = 'ai';
    } catch (e) {
      if (!cfg.fallbackToRules) throw new ApiError(502, e.code || 'ai_failed', friendlyAiError(e));
      notice = `${friendlyAiError(e)} Showing results from CareBridge's built-in rules instead.`;
    }
  }
  return buildAnalysis(docs, raw, { mode, provider: mode === 'ai' ? cfg.ai.provider : 'none', model: mode === 'ai' ? cfg.ai.model : '', today, notice, now });
}

export async function findMissing(input, cfg, opts = {}) {
  const docs = sanitizeDocs(input?.documents, cfg.limits);
  const now = opts.now || new Date();
  return runMissing({ docs, an: sanitizeAnalysisIn(input?.analysis), cfg, today: resolveToday(input?.today, now), now, opts });
}

const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function transcribeImage(input, cfg, opts = {}) {
  if (cfg.ai.provider === 'none') throw new ApiError(409, 'no_ai', 'Reading images with AI needs an AI provider. CareBridge will read the image on this device instead.');
  const mime = String(input?.mime || '').toLowerCase();
  if (!MIMES.has(mime)) throw new ApiError(415, 'unsupported_image', 'Use a JPEG, PNG or WebP image.');
  const data = String(input?.data || '').replace(/\s/g, '');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new ApiError(400, 'bad_image', 'The image data was not valid.');
  if (Math.floor((data.length * 3) / 4) > cfg.limits.maxImageBytes) throw new ApiError(413, 'image_too_large', 'That image is too large. Try a smaller photo.');
  let text;
  try {
    text = await callText(cfg, { ...transcribePrompt(input?.name), image: { mime, data } }, opts);
  } catch (e) {
    throw new ApiError(502, e.code || 'ai_failed', friendlyAiError(e));
  }
  const pages = text.split(/^\s*=== ?page break ?===\s*$/im).map((t) => cleanText(t).trim()).filter(Boolean).map((t, i) => ({ page: i + 1, text: t }));
  if (!pages.length) throw new ApiError(422, 'no_text', 'No text could be read from that image. Try a clearer photo.');
  return { pages, model: cfg.ai.model };
}
