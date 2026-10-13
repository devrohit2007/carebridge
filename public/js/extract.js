// Reads files on the device: PDF text (pdf.js, bundled locally), photos (AI vision when available, else on-device OCR), text files.
// Raw files are never uploaded; only the extracted text is sent for analysis.
import * as api from './api.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const OCR_PAGE_CAP = 6;
let pdfjs = null;
let ocrWorker = null;

const extOf = (n) => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
export function kindOfFile(f) {
  const e = extOf(f.name);
  if (f.type === 'application/pdf' || e === 'pdf') return 'pdf';
  if (f.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'].includes(e)) return 'image';
  if (f.type.startsWith('text/') || ['txt', 'md', 'text'].includes(e)) return 'text';
  return null;
}

// ---------- pdf.js ----------
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  const attempts = ['/vendor/pdfjs/legacy/', '/vendor/pdfjs/']; // legacy build first: it also runs on older Android browsers
  let lastError;
  for (const base of attempts) {
    try {
      const mod = await import(`${base}pdf.min.mjs`);
      mod.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
      pdfjs = mod;
      return mod;
    } catch (e) { lastError = e; }
  }
  throw new Error(`The PDF reader could not start in this browser (${lastError?.message || 'unknown error'}). Paste the text instead.`);
}

/** Turn pdf.js text items into lines; wide horizontal gaps become 3 spaces so table columns survive. */
export function itemsToText(items) {
  const rows = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.transform) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const hgt = Math.abs(it.height) || 10;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, hgt * 0.45));
    if (!row) { row = { y, h: hgt, parts: [] }; rows.push(row); }
    row.h = Math.max(row.h, hgt);
    row.parts.push({ x, w: it.width || 0, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  const out = [];
  let prev = null;
  for (const r of rows) {
    r.parts.sort((a, b) => a.x - b.x);
    let line = '';
    let end = null;
    let sawSpace = false;
    for (const p of r.parts) {
      // pdf.js reports gaps (e.g. table columns) as separate whitespace items: use them as a signal, not as text
      if (!p.s.trim()) { sawSpace = sawSpace || line.length > 0; continue; }
      if (end !== null) {
        const gap = p.x - end;
        line += gap > r.h * 1.2 ? '   ' : gap > r.h * 0.12 || sawSpace ? ' ' : '';
      }
      line += p.s;
      end = p.x + p.w;
      sawSpace = false;
    }
    line = line.replace(/[ \t]+$/, '');
    if (!line.trim()) continue;
    if (prev && prev.y - r.y > Math.max(prev.h, r.h) * 1.9) out.push('');
    out.push(line);
    prev = r;
  }
  return out.join('\n');
}

// ---------- OCR on device (tesseract.js, loaded only when needed) ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = resolve;
    s.onerror = () => reject(new Error('Could not download the on-device OCR engine. Check your connection, or paste the text instead.'));
    document.head.append(s);
  });
}
async function getOcr(onStatus) {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  ocrWorker = await window.Tesseract.createWorker('eng', 1, { logger: (m) => { if (m.status === 'recognizing text') onStatus?.(Math.round(m.progress * 100)); } });
  return ocrWorker;
}
export async function stopOcr() {
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch { /* ignore */ } ocrWorker = null; }
}
async function ocr(canvas, onStatus) {
  const w = await getOcr(onStatus);
  const { data } = await w.recognize(canvas);
  return { text: data.text || '', confidence: Math.round(data.confidence || 0) };
}

async function bitmapOf(file, maxSide) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('This image format cannot be opened here. Use a JPEG or PNG photo (iPhone HEIC photos must be converted first).'); }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}
const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

// ---------- public ----------
export function splitSections(text) {
  const clean = String(text).replace(/\r\n?/g, '\n').trim();
  if (clean.includes('\f')) return { unit: 'page', pages: clean.split('\f').map((t) => t.trim()).filter(Boolean).map((t, i) => ({ page: i + 1, text: t })) };
  if (clean.length <= 3500) return { unit: 'section', pages: [{ page: 1, text: clean }] };
  const pages = [];
  let buf = '';
  for (const para of clean.split(/\n{2,}/)) {
    if (buf && buf.length + para.length > 3000) { pages.push(buf); buf = ''; }
    buf += (buf ? '\n\n' : '') + para;
  }
  if (buf) pages.push(buf);
  return { unit: 'section', pages: pages.map((t, i) => ({ page: i + 1, text: t })) };
}

export function makeTextDoc(id, name, text, origin = 'paste') {
  const { unit, pages } = splitSections(text);
  return { id, name, origin, unit, pages, ocrConfidence: null, warnings: [] };
}

/**
 * Read one file into a document. `ctx` = { id, health, onStatus(text, pct) }.
 * Throws Error with a plain-language message.
 */
export async function extractFile(file, ctx) {
  const kind = kindOfFile(file);
  if (!kind) throw new Error(`"${file.name}" is not a PDF, photo or text file.`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`"${file.name}" is larger than 25 MB. Try a smaller file.`);
  const { id, health, onStatus = () => {} } = ctx;
  const maxPages = health?.limits?.maxPagesPerDoc ?? 60;
  const doc = { id, name: file.name.replace(/\.[a-z0-9]+$/i, ''), size: file.size, unit: 'page', pages: [], ocrConfidence: null, warnings: [], origin: 'text' };

  if (kind === 'text') {
    const t = await file.text();
    return { ...doc, ...makeTextDoc(id, doc.name, t, 'text'), size: file.size };
  }

  if (kind === 'pdf') {
    onStatus('Opening PDF', null);
    const lib = await loadPdfJs();
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false, disableFontFace: true });
    let pdf;
    try { pdf = await task.promise; } catch (e) {
      if (e?.name === 'PasswordException') throw new Error(`"${file.name}" is password-protected. Remove the password and add it again.`);
      throw new Error(`"${file.name}" could not be read as a PDF.`);
    }
    if (pdf.numPages > maxPages) throw new Error(`"${file.name}" has ${pdf.numPages} pages; the limit is ${maxPages}. Add the pages that matter.`);
    doc.origin = 'pdf';
    let ocrPages = 0;
    let confSum = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      onStatus(`Reading page ${n} of ${pdf.numPages}`, Math.round(((n - 1) / pdf.numPages) * 100));
      const page = await pdf.getPage(n);
      let text = itemsToText((await page.getTextContent()).items);
      if (text.replace(/\s/g, '').length < 25 && ocrPages < OCR_PAGE_CAP) {
        // scanned page: render it and read it with OCR
        try {
          const vp = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          onStatus(`Page ${n} is a scan: reading it with OCR`, 0);
          const r = await ocr(canvas, (p) => onStatus(`Page ${n} is a scan: reading it with OCR`, p));
          text = r.text; confSum += r.confidence; ocrPages += 1;
        } catch (e) { doc.warnings.push(`Page ${n} looks like a scan and could not be read (${e.message}).`); }
      }
      if (text.trim()) doc.pages.push({ page: n, text: text.trim() });
    }
    if (ocrPages) {
      doc.origin = 'ocr';
      doc.ocrConfidence = Math.round(confSum / ocrPages);
      doc.warnings.push('Some pages were scans read with OCR and may contain mistakes. Check numbers against the original.');
      await stopOcr();
    }
    if (!doc.pages.length) throw new Error(`No text could be read from "${file.name}". If it is a scan, add a clear photo of each page instead.`);
    return doc;
  }

  // image
  doc.previewUrl = URL.createObjectURL(file);
  if (health?.mode === 'ai') {
    try {
      onStatus('Reading the photo with AI', null);
      const canvas = await bitmapOf(file, 1800);
      const jpeg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
      const out = await api.transcribe(file.name, 'image/jpeg', await toBase64(jpeg));
      doc.origin = 'image-ai';
      doc.pages = out.pages;
      doc.warnings.push('This text was read from a photo by an AI model and may contain mistakes. Check doses, dates and values against the original.');
      return doc;
    } catch (e) {
      if (e.status === 401 || e.status === 429) throw e;
      doc.warnings.push('AI photo reading was not available, so the photo was read on this device instead.');
    }
  }
  onStatus('Reading the photo on this device (first use downloads the OCR engine)', 0);
  const canvas = await bitmapOf(file, 2200);
  const r = await ocr(canvas, (p) => onStatus('Reading the photo on this device', p));
  await stopOcr();
  if (r.text.replace(/\s/g, '').length < 15) throw new Error(`Very little text could be read from "${file.name}". Try a sharper, well-lit photo or paste the text.`);
  doc.origin = 'ocr';
  doc.ocrConfidence = r.confidence;
  doc.pages = [{ page: 1, text: r.text.trim() }];
  doc.warnings.push(`Read on this device with OCR (${r.confidence}% confidence). Photos can be misread: check doses, dates and values against the original.`);
  return doc;
}
