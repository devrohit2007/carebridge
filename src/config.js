// Configuration: environment variables (+ optional .env file). No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '1.1.0';

export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    out[key] = val;
  }
  return out;
}

/** Load .env into `env` without overriding variables that are already set. */
export function loadDotenv(file = path.join(ROOT, '.env'), env = process.env) {
  try {
    const parsed = parseDotenv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined) env[k] = v;
  } catch {
    /* no .env file: fine */
  }
}

const int = (v, d, min = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? n : d;
};
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

const DEFAULT_MODEL = {
  gemini: 'gemini-flash-latest', // alias that follows Google's newest Flash model
  anthropic: 'claude-haiku-4-5-20251001',
  openai: '', // must be set explicitly: model names differ per provider
};
const DEFAULT_BASE = {
  gemini: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export function loadConfig(env = process.env) {
  const warnings = [];
  const apiKey = (env.AI_API_KEY || '').trim();
  let provider = (env.AI_PROVIDER || '').trim().toLowerCase();
  if (!['gemini', 'openai', 'anthropic', 'none'].includes(provider)) provider = apiKey ? 'gemini' : 'none';

  if (provider !== 'none' && !apiKey) {
    warnings.push('AI_API_KEY is empty: running in rules-only mode (no AI model).');
    provider = 'none';
  }
  const model = (env.AI_MODEL || DEFAULT_MODEL[provider] || '').trim();
  if (provider === 'openai' && !model) {
    warnings.push('AI_PROVIDER=openai needs AI_MODEL (and usually AI_BASE_URL). Running in rules-only mode.');
    provider = 'none';
  }
  const baseUrl = ((env.AI_BASE_URL || '').trim() || DEFAULT_BASE[provider] || '').replace(/\/+$/, '');

  return Object.freeze({
    port: int(env.PORT, 8787, 1),
    host: (env.HOST || '127.0.0.1').trim(),
    trustProxy: bool(env.TRUST_PROXY, false),
    ai: Object.freeze({
      provider,
      apiKey: provider === 'none' ? '' : apiKey,
      model: provider === 'none' ? '' : model,
      baseUrl,
      timeoutMs: int(env.AI_TIMEOUT_MS, 90000, 1000),
      maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 12000, 512),
      // 'off' (default) asks Gemini for the least "thinking" time, which is the biggest speed-up; 'default' leaves the model's own setting.
      thinking: /^(default|on)$/i.test(String(env.AI_THINKING || '').trim()) ? 'default' : 'off',
    }),
    fallbackToRules: bool(env.FALLBACK_TO_RULES, true),
    accessCode: (env.ACCESS_CODE || '').trim(),
    rateLimit: { max: int(env.RATE_LIMIT_MAX, 30, 1), windowMs: int(env.RATE_LIMIT_WINDOW_MS, 600000, 1000) },
    limits: Object.freeze({
      maxBodyBytes: int(env.MAX_BODY_BYTES, 2_000_000, 10_000),
      maxImageBytes: int(env.MAX_IMAGE_BYTES, 5_000_000, 10_000),
      maxDocs: int(env.MAX_DOCS, 10, 1),
      maxPagesPerDoc: int(env.MAX_PAGES_PER_DOC, 60, 1),
      maxCharsPerDoc: int(env.MAX_CHARS_PER_DOC, 60000, 1000),
      maxTotalChars: int(env.MAX_TOTAL_CHARS, 150000, 1000),
    }),
    warnings,
  });
}

/** What the browser is allowed to know. Never includes the API key or access code. */
export function publicInfo(cfg) {
  const ai = cfg.ai.provider !== 'none';
  return {
    ok: true,
    app: 'carebridge',
    version: VERSION,
    mode: ai ? 'ai' : 'rules',
    provider: cfg.ai.provider,
    model: cfg.ai.model,
    vision: ai, // all supported providers accept images
    accessCodeRequired: Boolean(cfg.accessCode),
    limits: {
      maxDocs: cfg.limits.maxDocs,
      maxPagesPerDoc: cfg.limits.maxPagesPerDoc,
      maxCharsPerDoc: cfg.limits.maxCharsPerDoc,
      maxTotalChars: cfg.limits.maxTotalChars,
      maxImageBytes: cfg.limits.maxImageBytes,
    },
  };
}
