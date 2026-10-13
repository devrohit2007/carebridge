// Smoke test against a RUNNING server:   npm start   (in one Termux session)   then   npm run smoke   (in another)
// Usage: node scripts/smoke.js [baseUrl]      default http://127.0.0.1:8787
// Add ACCESS_CODE=... in the environment if the server requires an access code.
const base = (process.argv[2] || process.env.CAREBRIDGE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const headers = { 'content-type': 'application/json', ...(process.env.ACCESS_CODE ? { 'x-access-code': process.env.ACCESS_CODE } : {}) };
let failed = 0;
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`); if (!ok) failed++; };

async function call(path, body) {
  const res = await fetch(base + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : {});
  return { res, json: await res.json().catch(() => null) };
}

try {
  const health = await call('/api/health');
  check('server answers /api/health', health.res.ok, `mode=${health.json?.mode} provider=${health.json?.provider} model=${health.json?.model || '-'}`);
  check('security headers present', Boolean(health.res.headers.get('content-security-policy')) && health.res.headers.get('x-content-type-options') === 'nosniff');
  check('API key is never exposed', !/key/i.test(JSON.stringify(health.json).replace(/accessCodeRequired/, '')));

  const page = await fetch(base + '/');
  check('web app is served', page.ok && (await page.text()).includes('CareBridge'));

  const samples = await call('/api/samples');
  check('sample documents available', samples.json?.documents?.length === 3);

  const t0 = Date.now();
  const analysis = await call('/api/analyze', { documents: samples.json.documents, today: new Date().toISOString().slice(0, 10) });
  const a = analysis.json;
  check('analysis succeeded', analysis.res.ok, `${((Date.now() - t0) / 1000).toFixed(1)}s, mode=${a?.meta?.mode}${a?.meta?.notice ? `, notice: ${a.meta.notice}` : ''}`);
  if (analysis.res.ok) {
    check('medication conflict found (Metformin twice vs once daily)', a.findings.some((f) => f.kind === 'medication_conflict' && /Metformin/i.test(f.title)));
    check('follow-ups found', a.followUps.length >= 3, `${a.followUps.length}`);
    check('flagged results found', a.results.filter((r) => r.flagged).length >= 3);
    check('every source is verified against the documents', [...a.findings, ...a.followUps, ...a.results].every((x) => x.sources.every((s) => s.verified)));
    check('doctor visit brief built', /DOCTOR VISIT BRIEF/.test(a.briefText));
    const m = await call('/api/missing', { documents: samples.json.documents, analysis: a, today: a.meta.today });
    check('"What am I missing?" works', m.res.ok && m.json.items.length > 0, `${m.json?.items?.length ?? 0} items, mode=${m.json?.mode}`);
  } else console.log('       ', analysis.json?.error?.message);
} catch (e) {
  console.log(`FAIL  could not reach ${base}: ${e.message}\n      Is the server running?  (npm start)`);
  failed++;
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll smoke checks passed.');
process.exit(failed ? 1 : 0);
