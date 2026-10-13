// Input validation and coercion. Everything from the browser or from a model is treated as untrusted.
import { ApiError } from './errors.js';
import { cleanText, clip, isoOrNull } from './normalize.js';

export const KINDS = ['prescription', 'lab_report', 'discharge_summary', 'clinical_note', 'imaging_report', 'billing_or_insurance', 'other'];
export const ACTIONS = ['start', 'continue', 'stop', 'change', 'as_needed', 'avoid', 'mention'];
export const CATEGORIES = ['visit', 'medication', 'test', 'procedure', 'followup', 'other'];
const ORIGINS = ['pdf', 'image-ai', 'ocr', 'text', 'paste', 'sample'];

const str = (v, max = 300) => (typeof v === 'string' || typeof v === 'number' ? clip(String(v), max) : '');
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const arr = (v, max = 60) => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const page = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 10000 ? Number(v) : 1);

/** Validate the documents sent by the browser. Throws ApiError with a message the user can act on. */
export function sanitizeDocs(input, limits) {
  const list = arr(input, 1000);
  if (!list.length) throw new ApiError(400, 'no_documents', 'Add at least one document to analyze.');
  if (list.length > limits.maxDocs) throw new ApiError(413, 'too_many_documents', `You can analyze up to ${limits.maxDocs} documents at a time.`);

  const ids = new Set();
  let total = 0;
  const docs = list.map((d, i) => {
    const o = obj(d);
    let id = typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(o.id) ? o.id : `d${i + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    const name = str(String(o.name ?? '').replace(/[<>"\r\n]/g, ' '), 120) || `Document ${i + 1}`;
    const pagesIn = arr(o.pages, limits.maxPagesPerDoc + 1);
    if (pagesIn.length > limits.maxPagesPerDoc) throw new ApiError(413, 'too_many_pages', `"${name}" has more than ${limits.maxPagesPerDoc} pages. Split it or add the pages that matter.`);
    let chars = 0;
    const pages = [];
    pagesIn.forEach((p, j) => {
      const text = cleanText(obj(p).text, limits.maxCharsPerDoc + 1).trim();
      chars += text.length;
      if (text) pages.push({ page: page(obj(p).page ?? j + 1), text });
    });
    if (chars > limits.maxCharsPerDoc) throw new ApiError(413, 'document_too_long', `"${name}" is longer than ${limits.maxCharsPerDoc.toLocaleString('en')} characters. Add fewer pages.`);
    total += chars;
    const conf = o.ocrConfidence == null || o.ocrConfidence === '' ? NaN : Number(o.ocrConfidence);
    return {
      id,
      name,
      origin: oneOf(o.origin, ORIGINS, 'text'),
      unit: o.unit === 'section' ? 'section' : 'page',
      ocrConfidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : null,
      pages,
    };
  });
  if (total > limits.maxTotalChars) {
    throw new ApiError(413, 'too_long', `Your documents contain ${total.toLocaleString('en')} characters; the limit is ${limits.maxTotalChars.toLocaleString('en')}. Remove a document or the pages you do not need.`);
  }
  if (!docs.some((d) => d.pages.length)) throw new ApiError(422, 'no_text', 'No readable text was found. If a file is a photo or scan, add a clearer one or paste the text.');
  return docs;
}

const src = (o) => ({ docId: str(obj(o).docId, 40), page: page(obj(o).page), quote: str(obj(o).quote, 300) });

/** Coerce a model's JSON into the exact shape the pipeline expects. Unknown keys are dropped. */
export function coerceRaw(raw) {
  const r = obj(raw);
  return {
    documents: arr(r.documents, 20).map((d) => ({
      docId: str(obj(d).docId, 40),
      kind: oneOf(obj(d).kind, KINDS, null),
      date: isoOrNull(obj(d).date),
      provider: str(obj(d).provider, 80) || null,
      summary: str(obj(d).summary, 300),
    })),
    medications: arr(r.medications, 60).map((m) => ({
      ...src(m),
      name: str(obj(m).name, 80),
      dose: str(obj(m).dose, 40) || null,
      frequency: str(obj(m).frequency, 60) || null,
      route: str(obj(m).route, 30) || null,
      duration: str(obj(m).duration, 40) || null,
      action: oneOf(obj(m).action, ACTIONS, 'mention'),
    })),
    instructions: arr(r.instructions, 40).map((i) => ({ ...src(i), text: str(obj(i).text, 240) })),
    events: arr(r.events, 60).map((e) => ({
      ...src(e),
      date: isoOrNull(obj(e).date),
      dateText: str(obj(e).dateText, 40) || null,
      label: str(obj(e).label, 120),
      category: oneOf(obj(e).category, CATEGORIES, 'other'),
    })),
    followUps: arr(r.followUps, 40).map((f) => {
      const rel = obj(obj(f).relative);
      return {
        ...src(f),
        action: str(obj(f).action, 160),
        timeframeText: str(obj(f).timeframeText, 60) || null,
        dueDate: isoOrNull(obj(f).dueDate),
        relative: Number(rel.amount) > 0 && Number(rel.amount) <= 120 ? { amount: Number(rel.amount), unit: str(rel.unit, 10) } : null,
        whyEasyToMiss: str(obj(f).whyEasyToMiss, 220),
      };
    }),
    results: arr(r.results, 120).map((x) => ({
      ...src(x),
      test: str(obj(x).test, 80),
      value: str(obj(x).value, 24),
      unit: str(obj(x).unit, 24) || null,
      range: str(obj(x).range, 40) || null,
      flag: str(obj(x).flag, 20) || null,
    })),
    issues: arr(r.issues, 20).map((i) => ({
      title: str(obj(i).title, 140),
      explanation: str(obj(i).explanation, 420),
      question: str(obj(i).question, 220),
      sources: arr(obj(i).sources, 6).map(src),
    })),
    questions: arr(r.questions, 20).map((q) => str(q, 220)).filter(Boolean),
    summary: str(r.summary, 500),
  };
}

/** Second-pass ("What am I missing?") model output. */
export function coerceMissing(raw) {
  const r = obj(raw);
  return arr(r.items, 20).map((i) => ({
    title: str(obj(i).title, 140),
    explanation: str(obj(i).explanation, 420),
    why: str(obj(i).why, 320),
    question: str(obj(i).question, 220),
    priority: oneOf(obj(i).priority, ['high', 'medium', 'low'], 'medium'),
    sources: arr(obj(i).sources, 6).map(src),
  }));
}

/** The browser sends the first-pass analysis back for the "What am I missing?" call. Keep only what we use, re-typed. */
export function sanitizeAnalysisIn(input) {
  const a = obj(input);
  const sources = (v) => arr(v, 8).map((s) => ({ docId: str(obj(s).docId, 40), docName: str(obj(s).docName, 120), page: page(obj(s).page), unit: obj(s).unit === 'section' ? 'section' : 'page', quote: str(obj(s).quote, 300), verified: obj(s).verified === true }));
  return {
    documents: arr(a.documents, 20).map((d) => ({ id: str(obj(d).id, 40), name: str(obj(d).name, 120), kind: oneOf(obj(d).kind, KINDS, 'other'), date: isoOrNull(obj(d).date), pages: Number(obj(d).pages) || 0, origin: oneOf(obj(d).origin, ORIGINS, 'text'), ocrConfidence: obj(d).ocrConfidence == null || !Number.isFinite(Number(obj(d).ocrConfidence)) ? null : Number(obj(d).ocrConfidence) })),
    medications: arr(a.medications, 80).map((m) => ({ id: str(obj(m).id, 20), key: str(obj(m).key, 60), name: str(obj(m).name, 80), action: oneOf(obj(m).action, ACTIONS, 'mention'), perDay: obj(m).perDay == null || !Number.isFinite(Number(obj(m).perDay)) ? null : Number(obj(m).perDay), asNeeded: obj(m).asNeeded === true, doseText: str(obj(m).doseText, 40) || null, frequencyText: str(obj(m).frequencyText, 60) || null, sources: sources(obj(m).sources) })),
    followUps: arr(a.followUps, 60).map((f) => ({ id: str(obj(f).id, 20), action: str(obj(f).action, 160), timeframeText: str(obj(f).timeframeText, 60) || null, dueDate: isoOrNull(obj(f).dueDate), dueEstimated: obj(f).dueEstimated === true, status: oneOf(obj(f).status, ['overdue', 'soon', 'upcoming', 'undated'], 'undated'), buried: obj(f).buried === true, sources: sources(obj(f).sources) })),
    results: arr(a.results, 150).map((r) => ({ id: str(obj(r).id, 20), test: str(obj(r).test, 80), value: str(obj(r).value, 24), unit: str(obj(r).unit, 24) || null, range: str(obj(r).range, 40) || null, flag: oneOf(obj(r).flag, ['high', 'low', 'abnormal'], null), flagged: obj(r).flagged === true, sources: sources(obj(r).sources) })),
    instructions: arr(a.instructions, 60).map((i) => ({ id: str(obj(i).id, 20), text: str(obj(i).text, 240), sources: sources(obj(i).sources) })),
    warningSigns: arr(a.warningSigns, 10).map((w) => ({ id: str(obj(w).id, 20), text: str(obj(w).text, 260), sources: sources(obj(w).sources) })),
    findings: arr(a.findings, 80).map((f) => ({ title: str(obj(f).title, 140), kind: str(obj(f).kind, 30), category: str(obj(f).category, 20) })),
  };
}
