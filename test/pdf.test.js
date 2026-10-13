// Real PDF extraction: the bundled pdf.js + CareBridge's own line reconstruction, run on the sample PDFs in Node.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { analyzeDocuments } from '../src/analyze.js';
import { ROOT, loadConfig } from '../src/config.js';

const NOW = new Date('2026-10-04T10:00:00Z');
const dir = path.join(ROOT, 'samples');
const have = fs.existsSync(path.join(dir, '1-prescription.pdf'));

// The browser build of pdf.js expects a few DOM classes at load time; text extraction never uses them.
globalThis.DOMMatrix ??= class { constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); } multiplySelf() { return this; } preMultiplySelf() { return this; } translate() { return this; } scale() { return this; } invertSelf() { return this; } };
globalThis.Path2D ??= class {};
globalThis.ImageData ??= class {};

async function readPdf(file) {
  const { itemsToText } = await import('../public/js/extract.js');
  const pdfjs = await import(pathToFileURL(path.join(ROOT, 'public/vendor/pdfjs/legacy/pdf.min.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(ROOT, 'public/vendor/pdfjs/legacy/pdf.worker.min.mjs')).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) pages.push({ page: n, text: itemsToText((await (await pdf.getPage(n)).getTextContent()).items) });
  return pages;
}

test('sample PDFs: text and table columns survive extraction', { skip: !have }, async () => {
  const lab = (await readPdf(path.join(dir, '2-lab-report.pdf')))[0].text;
  assert.match(lab, /HbA1c {2,}8\.2 {2,}% {2,}4\.0 - 5\.6 {2,}H/);
  assert.match(lab, /eGFR {2,}52 {2,}mL\/min {2,}> 60 {2,}L/);
  const rx = (await readPdf(path.join(dir, '1-prescription.pdf')))[0].text;
  assert.match(rx, /Tab\. Metformin 500 mg - take twice daily after meals/);
  const dc = await readPdf(path.join(dir, '3-discharge-summary.pdf'));
  assert.equal(dc.length, 3);
  assert.match(dc[2].text, /Review with Dr\. Rao in 2 weeks\./);
});

test('sample PDFs go through the whole pipeline like the built-in samples', { skip: !have }, async () => {
  const names = ['1-prescription.pdf', '2-lab-report.pdf', '3-discharge-summary.pdf'];
  const documents = [];
  for (const [i, n] of names.entries()) documents.push({ id: `d${i + 1}`, name: n.replace('.pdf', ''), origin: 'pdf', unit: 'page', pages: await readPdf(path.join(dir, n)) });
  const a = await analyzeDocuments({ documents, today: '2026-10-04' }, loadConfig({}), { now: NOW });
  assert.ok(a.findings.some((f) => f.kind === 'medication_conflict' && /Metformin/.test(f.title)));
  assert.deepEqual(a.results.filter((r) => r.flagged).map((r) => r.test).sort(), ['Creatinine', 'Fasting glucose', 'HbA1c', 'eGFR']);
  assert.ok(a.followUps.length >= 3);
  assert.equal(a.warningSigns.length, 1);
});
