// End-to-end API tests: a real CareBridge server talking to mock AI providers over HTTP.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../server.js';
import { loadConfig } from '../src/config.js';
import { buildSampleDocuments } from '../src/samples.js';

process.env.CAREBRIDGE_TEST = '1';
process.env.CAREBRIDGE_QUIET = '1';
const NOW = new Date('2026-10-04T10:00:00Z');
const docs = buildSampleDocuments(NOW);

// ---- mock AI provider speaking the Gemini, OpenAI and Anthropic wire formats ----
const EXTRACTION = {
  documents: [{ docId: 'd1', kind: 'prescription', date: '2026-09-13', provider: 'Dr. Anil Rao', summary: 'Outpatient prescription.' }],
  medications: [
    { docId: 'd1', page: 1, quote: 'Tab. Metformin 500 mg - take twice daily after meals - for 30 days', name: 'Metformin', dose: '500 mg', frequency: 'twice daily', action: 'start' },
    { docId: 'd3', page: 1, quote: 'Tab. Metformin 500 mg - once daily after dinner', name: 'Metformin', dose: '500 mg', frequency: 'once daily', action: 'continue' },
    { docId: 'd3', page: 1, quote: 'Tab. Warfarin 5 mg - once daily at night', name: 'Warfarin', dose: '5 mg', frequency: 'once daily', action: 'start' },
  ],
  followUps: [{ docId: 'd3', page: 3, quote: 'Review with Dr. Rao in 2 weeks.', action: 'Review with Dr. Rao', timeframeText: 'in 2 weeks', relative: { amount: 2, unit: 'weeks' }, whyEasyToMiss: 'Listed at the very end of the discharge summary.' }],
  issues: [
    { title: 'Diet advice is worded differently', explanation: 'The prescription advises reducing salt and sugar, while the discharge summary refers to a diabetic diet plan from the dietitian; the documents do not say how the two fit together.', question: 'Which diet advice should I follow?', sources: [{ docId: 'd1', page: 1, quote: 'Reduce salt and sugar intake.' }, { docId: 'd3', page: 2, quote: 'Follow a diabetic diet as explained by the dietitian.' }] },
    { title: 'Possible condition', explanation: 'You likely have diabetes and you should stop taking metformin.', sources: [{ docId: 'd2', page: 1, quote: 'HbA1c 8.2 % 4.0 - 5.6 H' }] },
    { title: 'Invented', explanation: 'The documents mention a second specialist.', sources: [{ docId: 'd1', page: 1, quote: 'Refer to the cardiology department urgently' }] },
  ],
  questions: ['What should I do if I miss a dose?', 'You should double your dose?'],
  summary: 'Three documents were provided: a prescription, a lab report and a discharge summary.',
};
const MISSING = {
  items: [
    { title: 'Diet advice appears only once', explanation: 'The discharge summary mentions a diabetic diet; the other documents give no diet details.', why: 'It sits in the middle of a list.', question: 'Can the dietitian give me the diet in writing?', priority: 'medium', sources: [{ docId: 'd3', page: 2, quote: 'Follow a diabetic diet as explained by the dietitian.' }] },
    { title: 'Made up item', explanation: 'Something that is not in the documents.', sources: [{ docId: 'd1', page: 1, quote: 'Bring your insurance card' }] },
  ],
};

function startMock() {
  const state = { calls: [], failures: [], garbage: false, rejectResponseFormatOnce: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const j = raw ? JSON.parse(raw) : {};
      state.calls.push({ url: req.url, headers: req.headers, body: j });
      if (state.failures.length) {
        const status = state.failures.shift();
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `mock failure ${status}` } }));
      }
      let system = '';
      let gemini = false;
      let anthropic = false;
      if (req.url.startsWith('/v1beta/models/')) { system = j.systemInstruction.parts[0].text; gemini = true; }
      else if (req.url === '/chat/completions') {
        if (state.rejectResponseFormatOnce && j.response_format) {
          state.rejectResponseFormatOnce = false;
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'response_format is not supported by this model' } }));
        }
        system = j.messages[0].content;
      } else if (req.url === '/v1/messages') { system = j.system; anthropic = true; }
      else { res.writeHead(404); return res.end('{}'); }
      let text;
      if (state.garbage) text = 'I am sorry, I cannot help with that request.';
      else if (/SECOND READER/.test(system)) text = JSON.stringify(MISSING);
      else if (/transcribe/i.test(system)) text = 'Tab. Metformin 500 mg - twice daily\n=== page break ===\nReview in 2 weeks';
      else text = `\`\`\`json\n${JSON.stringify(EXTRACTION)}\n\`\`\``;
      const out = gemini
        ? { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }
        : anthropic ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
          : { choices: [{ message: { content: text }, finish_reason: 'stop' }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

let mock;
before(async () => { mock = await startMock(); });
after(() => mock.server.close());

async function withApp(env, fn, appOpts = {}) {
  const cfg = loadConfig({ AI_BASE_URL: mock.url, AI_API_KEY: 'test-key-123', AI_MODEL: 'test-model', ...env });
  const server = createApp(cfg, { nowFn: () => NOW, ...appOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, cfg); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
async function post(base, path, body, headers = {}, raw = false) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
}
const analyzeBody = () => ({ documents: docs, today: '2026-10-04' });

function checkAiAnalysis(a) {
  assert.equal(a.meta.mode, 'ai');
  assert.ok(!a.medications.some((m) => /warfarin/i.test(m.name)), 'hallucinated medication removed');
  assert.equal(a.findings.filter((f) => f.kind === 'medication_conflict').length, 1);
  const issue = a.findings.find((f) => f.kind === 'discrepancy');
  assert.ok(issue, 'AI discrepancy kept');
  assert.equal(issue.origin, 'ai');
  assert.equal(issue.compare.length, 2);
  assert.ok(!a.findings.some((f) => /Possible condition|Invented/.test(f.title)), 'unsafe + unverified issues removed');
  assert.ok(a.questions.some((q) => /miss a dose/.test(q.text)));
  assert.ok(!a.questions.some((q) => /double/.test(q.text)));
  assert.ok(a.meta.dropped.unverified >= 2 && a.meta.dropped.unsafe >= 2, JSON.stringify(a.meta.dropped));
  assert.equal(a.summary, 'Three documents were provided: a prescription, a lab report and a discharge summary.');
  assert.equal(a.followUps.filter((f) => /Review with Dr\. Rao/.test(f.action)).length, 1, 'AI and rules follow-up merged, not duplicated');
  assert.ok(a.followUps.length >= 3, 'rules safety-net still contributes the other follow-ups');
}

test('health endpoint exposes mode and limits but never secrets', async () => {
  await withApp({ AI_PROVIDER: 'gemini', ACCESS_CODE: 'sesame' }, async (base) => {
    const res = await fetch(`${base}/api/health`);
    const j = await res.json();
    assert.equal(j.mode, 'ai');
    assert.equal(j.provider, 'gemini');
    assert.equal(j.accessCodeRequired, true);
    assert.ok(!JSON.stringify(j).includes('test-key-123') && !JSON.stringify(j).includes('sesame'));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('Gemini adapter: JSON mode, key in header, verified + filtered output', async () => {
  mock.state.calls.length = 0;
  await withApp({ AI_PROVIDER: 'gemini' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.equal(r.status, 200, r.text);
    checkAiAnalysis(r.json);
    const call = mock.state.calls[0];
    assert.match(call.url, /^\/v1beta\/models\/test-model:generateContent$/);
    assert.equal(call.headers['x-goog-api-key'], 'test-key-123');
    assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
    const prompt = call.body.contents[0].parts[0].text;
    assert.match(prompt, /<document id="d3"/);
    assert.match(call.body.systemInstruction.parts[0].text, /Never diagnose/);
  });
});

test('OpenAI-compatible adapter: bearer auth, and retries without response_format when rejected', async () => {
  mock.state.calls.length = 0;
  mock.state.rejectResponseFormatOnce = true;
  await withApp({ AI_PROVIDER: 'openai' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.equal(r.status, 200, r.text);
    checkAiAnalysis(r.json);
    assert.equal(mock.state.calls.length, 2);
    assert.equal(mock.state.calls[0].headers.authorization, 'Bearer test-key-123');
    assert.ok(mock.state.calls[0].body.response_format);
    assert.ok(!mock.state.calls[1].body.response_format);
  });
});

test('Anthropic adapter: x-api-key + version header', async () => {
  mock.state.calls.length = 0;
  await withApp({ AI_PROVIDER: 'anthropic' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.equal(r.status, 200, r.text);
    checkAiAnalysis(r.json);
    const c = mock.state.calls[0];
    assert.equal(c.url, '/v1/messages');
    assert.equal(c.headers['x-api-key'], 'test-key-123');
    assert.equal(c.headers['anthropic-version'], '2023-06-01');
    assert.match(c.body.system, /Never diagnose/);
  });
});

test('transient provider errors are retried once', async () => {
  mock.state.failures = [429];
  await withApp({ AI_PROVIDER: 'gemini' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.equal(r.status, 200);
    assert.equal(r.json.meta.mode, 'ai');
  });
});

test('provider failure falls back to the rules engine with a plain-language notice', async () => {
  mock.state.failures = [500, 500];
  await withApp({ AI_PROVIDER: 'gemini' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.equal(r.status, 200);
    assert.equal(r.json.meta.mode, 'rules');
    assert.match(r.json.meta.notice, /AI service/);
    assert.ok(r.json.findings.some((f) => f.kind === 'medication_conflict'), 'results still useful');
    assert.ok(!JSON.stringify(r.json).includes('test-key-123'));
  });
  mock.state.failures = [401];
  await withApp({ AI_PROVIDER: 'gemini' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.match(r.json.meta.notice, /rejected the API key/);
  });
});

test('FALLBACK_TO_RULES=false surfaces a 502 instead', async () => {
  mock.state.failures = [500, 500];
  await withApp({ AI_PROVIDER: 'gemini', FALLBACK_TO_RULES: 'false' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.equal(r.status, 502);
    assert.match(r.json.error.message, /AI service/);
  });
});

test('non-JSON model replies are retried, then fall back safely', async () => {
  mock.state.garbage = true;
  mock.state.calls.length = 0;
  await withApp({ AI_PROVIDER: 'openai' }, async (base) => {
    const r = await post(base, '/api/analyze', analyzeBody());
    assert.equal(r.status, 200);
    assert.equal(r.json.meta.mode, 'rules');
    assert.match(r.json.meta.notice, /could not read/);
    assert.equal(mock.state.calls.length, 2, 'one repair attempt');
  });
  mock.state.garbage = false;
});

test('"What am I missing?" with AI: adds verified items, drops invented ones, keeps rule checks', async () => {
  await withApp({ AI_PROVIDER: 'gemini' }, async (base) => {
    const a = (await post(base, '/api/analyze', analyzeBody())).json;
    const r = await post(base, '/api/missing', { documents: docs, analysis: a, today: '2026-10-04' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mode, 'ai');
    assert.ok(r.json.items.some((i) => i.origin === 'ai' && /Diet advice/.test(i.title)));
    assert.ok(!r.json.items.some((i) => /Made up/.test(i.title)));
    assert.ok(r.json.items.some((i) => i.kind === 'flagged_unreferenced'));
    assert.equal(r.json.checks.find((c) => c.id === 'ai').status, 'review');
    assert.ok(r.json.items.every((i) => i.sources.every((s) => s.verified)));
  });
  mock.state.failures = [500, 500];
  await withApp({ AI_PROVIDER: 'gemini' }, async (base) => {
    const r = await post(base, '/api/missing', { documents: docs, analysis: {}, today: '2026-10-04' });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'rules');
    assert.match(r.json.notice, /second reading/);
  });
});

test('image transcription: validates input, returns pages, needs an AI provider', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await withApp({ AI_PROVIDER: 'gemini' }, async (base) => {
    const ok = await post(base, '/api/transcribe', { name: 'rx.png', mime: 'image/png', data: png });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.pages.length, 2);
    assert.match(ok.json.pages[0].text, /Metformin/);
    const sent = mock.state.calls.at(-1).body.contents[0].parts[0];
    assert.equal(sent.inlineData.mimeType, 'image/png');
    assert.equal((await post(base, '/api/transcribe', { mime: 'image/gif', data: png })).status, 415);
    assert.equal((await post(base, '/api/transcribe', { mime: 'image/png', data: 'not base64!!' })).status, 400);
  });
  await withApp({ AI_PROVIDER: 'none' }, async (base) => {
    assert.equal((await post(base, '/api/transcribe', { mime: 'image/png', data: png })).status, 409);
  });
});

test('access code is required, compared safely, and never echoed', async () => {
  await withApp({ AI_PROVIDER: 'none', ACCESS_CODE: 'sesame' }, async (base) => {
    assert.equal((await post(base, '/api/analyze', analyzeBody())).status, 401);
    const wrong = await post(base, '/api/analyze', analyzeBody(), { 'x-access-code': 'nope' });
    assert.equal(wrong.status, 401);
    assert.ok(!wrong.text.includes('sesame'));
    assert.equal((await post(base, '/api/analyze', analyzeBody(), { 'x-access-code': 'sesame' })).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200, 'health stays open');
  });
});

test('rate limiting returns 429 with Retry-After', async () => {
  await withApp({ AI_PROVIDER: 'none', RATE_LIMIT_MAX: '2' }, async (base) => {
    assert.equal((await post(base, '/api/analyze', analyzeBody())).status, 200);
    assert.equal((await post(base, '/api/analyze', analyzeBody())).status, 200);
    const third = await post(base, '/api/analyze', analyzeBody());
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
  });
});

test('bad requests get clear 4xx answers, not crashes', async () => {
  await withApp({ AI_PROVIDER: 'none', MAX_BODY_BYTES: '10000' }, async (base) => {
    assert.equal((await post(base, '/api/analyze', '{not json', {}, true)).status, 400);
    assert.equal((await post(base, '/api/analyze', 'x', { 'content-type': 'text/plain' }, true)).status, 415);
    assert.equal((await post(base, '/api/analyze', { documents: [] })).status, 400);
    assert.equal((await post(base, '/api/analyze', { documents: [{ name: 'x', pages: [{ page: 1, text: '   ' }] }] })).status, 422);
    const big = await post(base, '/api/analyze', { documents: [{ name: 'big', pages: [{ page: 1, text: 'a'.repeat(20000) }] }] });
    assert.equal(big.status, 413);
    assert.equal((await fetch(`${base}/api/analyze`)).status, 405);
    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/api/health`)).status, 200, 'server still healthy');
  });
});

test('samples endpoint serves fresh synthetic documents', async () => {
  await withApp({ AI_PROVIDER: 'none' }, async (base) => {
    const j = await (await fetch(`${base}/api/samples`)).json();
    assert.equal(j.documents.length, 3);
    assert.match(j.documents[0].pages[0].text, /SAMPLE DOCUMENT/);
  });
});
