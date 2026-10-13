// Speed features: Gemini "thinking" is minimised (with automatic fallbacks) and aiMode "off" never calls the AI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeDocuments } from '../src/analyze.js';
import { loadConfig } from '../src/config.js';
import { callJson } from '../src/providers.js';
import { buildSampleDocuments } from '../src/samples.js';

const reply = (obj) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] }), { status: 200 });
const fail = (msg) => new Response(JSON.stringify({ error: { message: msg } }), { status: 400 });

test('Gemini: asks for minimal thinking, falls back through older names, then remembers what worked', async () => {
  const cfg = loadConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k', AI_MODEL: 'speed-model-a' });
  const seen = [];
  const fetchImpl = async (url, init) => {
    const t = JSON.parse(init.body).generationConfig.thinkingConfig;
    seen.push(t ?? null);
    if (t && 'thinkingLevel' in t) return fail('Invalid JSON payload received. Unknown name "thinkingLevel": Cannot find field.');
    return reply({ ok: true });
  };
  assert.deepEqual(await callJson(cfg, { system: 's', user: 'u' }, { fetchImpl }), { ok: true });
  assert.deepEqual(seen, [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }]);
  seen.length = 0;
  await callJson(cfg, { system: 's', user: 'u' }, { fetchImpl });
  assert.deepEqual(seen, [{ thinkingBudget: 0 }], 'the accepted setting is reused without retrying');
});

test('Gemini: a model that cannot turn thinking off still works (no thinking setting sent)', async () => {
  const cfg = loadConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k', AI_MODEL: 'speed-model-b' });
  const fetchImpl = async (url, init) => (JSON.parse(init.body).generationConfig.thinkingConfig ? fail('Thinking can not be disabled for this model') : reply({ ok: 1 }));
  assert.deepEqual(await callJson(cfg, { system: 's', user: 'u' }, { fetchImpl }), { ok: 1 });
});

test('Gemini: errors that are not about thinking are not swallowed', async () => {
  const cfg = loadConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k', AI_MODEL: 'speed-model-c' });
  let calls = 0;
  const fetchImpl = async () => { calls++; return fail('API key not valid'); };
  await assert.rejects(callJson(cfg, { system: 's', user: 'u' }, { fetchImpl }), /API key not valid/);
  assert.equal(calls, 1);
});

test('AI_THINKING=default leaves the model setting alone', async () => {
  const cfg = loadConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k', AI_MODEL: 'speed-model-d', AI_THINKING: 'default' });
  let body;
  await callJson(cfg, { system: 's', user: 'u' }, { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return reply({ ok: 1 }); } });
  assert.ok(!('thinkingConfig' in body.generationConfig));
});

test('aiMode "off" returns the built-in results instantly without any AI request', async () => {
  const cfg = loadConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k' });
  const fetchImpl = async () => { throw new Error('the AI must not be called'); };
  const a = await analyzeDocuments({ documents: buildSampleDocuments(new Date()), aiMode: 'off', today: new Date().toISOString().slice(0, 10) }, cfg, { fetchImpl });
  assert.equal(a.meta.mode, 'rules');
  assert.ok(a.findings.some((f) => f.kind === 'medication_conflict'));
});
