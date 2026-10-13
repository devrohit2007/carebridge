// How fast is my AI setup?   npm run bench
// Times one analysis of the 3 sample documents with the provider/model in your .env (no real documents are sent).
import { analyzeDocuments } from '../src/analyze.js';
import { loadConfig, loadDotenv } from '../src/config.js';
import { buildSampleDocuments } from '../src/samples.js';

loadDotenv();
const cfg = loadConfig();
if (cfg.ai.provider === 'none') {
  console.log('No AI is configured (AI_API_KEY is empty), so there is nothing to time. The built-in rules answer instantly.');
  process.exit(0);
}
console.log(`Provider: ${cfg.ai.provider}   Model: ${cfg.ai.model}   Thinking: ${cfg.ai.thinking}`);
const docs = buildSampleDocuments(new Date());
const t0 = Date.now();
try {
  const a = await analyzeDocuments({ documents: docs, today: new Date().toISOString().slice(0, 10) }, cfg);
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Analysis finished in ${s} s (mode: ${a.meta.mode}).`);
  if (a.meta.notice) console.log(`Note: ${a.meta.notice}`);
  console.log(s > 25 ? 'Slow. Try a lighter model, for example AI_MODEL=gemini-flash-lite-latest (run: npm run models).' : 'Good speed.');
} catch (e) {
  console.log(`Failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${e.message}`);
  process.exit(1);
}
