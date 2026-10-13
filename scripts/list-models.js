// Lists the model names your API key can use:   npm run models
// Use one of them as AI_MODEL in .env. Names change over time, so check here if you get "model not found".
import { loadConfig, loadDotenv } from '../src/config.js';
import { listModels } from '../src/providers.js';

loadDotenv();
const cfg = loadConfig();
if (cfg.ai.provider === 'none') {
  console.log('No AI provider configured. Set AI_PROVIDER and AI_API_KEY in .env first.');
  process.exit(1);
}
try {
  const models = await listModels(cfg);
  console.log(`${cfg.ai.provider}: ${models.length} models available to your key\n`);
  for (const m of models.sort()) console.log(`${m === cfg.ai.model ? '* ' : '  '}${m}`);
  console.log(`\n* = currently configured (AI_MODEL=${cfg.ai.model})`);
} catch (e) {
  console.error(`Could not list models: ${e.message}`);
  process.exit(1);
}
