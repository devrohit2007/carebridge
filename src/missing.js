// "What am I missing?" - a second look across ALL documents.
// Part 1 is deterministic code (always runs, works offline). Part 2 is an AI "second reader" whose output is verified like everything else.
import { verifySource } from './build.js';
import { fmtDate } from './brief.js';
import { clip, daysBetween, matchKey } from './normalize.js';
import { missingPrompt } from './prompts.js';
import { callJson } from './providers.js';
import { NEXT, safeText } from './safety.js';
import { coerceMissing } from './schema.js';

const GENERIC = new Set(['fasting', 'serum', 'total', 'level', 'levels', 'blood', 'test', 'plasma', 'random', 'post', 'prandial', 'count']);
const RANK = { high: 0, medium: 1, low: 2 };
const KIND_ORDER = ['followup_timing', 'flagged_unreferenced', 'buried_followup', 'medication_list_mismatch', 'ai_review', 'warning_signs', 'incomplete_instruction', 'undated_document', 'image_text'];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function reverify(docs, sources) {
  return sources.map((s) => verifySource(docs, s.docId, s.page, s.quote)).filter((s) => s.verified);
}

/** Checks that need no AI. `an` is the (re-typed) first-pass analysis; every source is re-verified against the documents. */
export function deterministicChecks(docs, an, today) {
  const items = [];
  let n = 0;
  const add = (check, o) => {
    const sources = reverify(docs, o.sources || []);
    if (!sources.length) return;
    items.push({ id: `x${++n}`, check, origin: 'rules', nextStep: NEXT.gap, ...o, sources });
  };
  const docName = (id) => an.documents.find((d) => d.id === id)?.name || docs.find((d) => d.id === id)?.name || 'a document';

  // 1. flagged results that no instruction mentions
  const haystack = matchKey([...an.followUps.map((f) => `${f.action} ${f.sources[0]?.quote || ''}`), ...an.instructions.map((i) => i.text), ...an.warningSigns.map((w) => w.text)].join(' '));
  for (const r of an.results.filter((x) => x.flagged)) {
    const tokens = r.test.split(/[^A-Za-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t.toLowerCase()));
    const keys = (tokens.length ? tokens : [r.test]).map(matchKey).filter(Boolean);
    if (keys.some((k) => haystack.includes(k))) continue;
    add('results', {
      kind: 'flagged_unreferenced', priority: 'medium',
      title: `${r.test} is flagged, but no follow-up instruction mentions it`,
      summary: `The report flags ${r.test} (${r.value}${r.unit ? ` ${r.unit}` : ''}${r.range ? `, printed range ${r.range}` : ''}). None of the follow-up or instruction text we found refers to it by name.`,
      why: 'That can be perfectly ordinary, or it may be covered under a different name. CareBridge cannot tell, so it is raised for you to check.',
      nextStep: NEXT.flagged, question: `Is the flagged ${r.test} result something I should discuss at my follow-up?`, sources: r.sources,
    });
  }

  // 2. follow-ups that are due soon or whose calculated date has passed
  for (const f of an.followUps.filter((x) => x.status === 'overdue' || x.status === 'soon')) {
    const d = f.dueDate ? daysBetween(today, f.dueDate) : 0;
    const when = f.dueDate ? fmtDate(f.dueDate) : '';
    add('dates', {
      kind: 'followup_timing', priority: f.status === 'overdue' ? 'high' : 'medium',
      title: f.status === 'overdue' ? `Check whether this was done: ${clip(f.action, 90)}` : `Coming up soon: ${clip(f.action, 90)}`,
      summary: f.status === 'overdue'
        ? `${f.dueEstimated ? 'The date calculated from the document' : 'The date given'} (${when}) was ${plural(Math.abs(d), 'day')} ago.`
        : `${f.dueEstimated ? 'The date calculated from the document' : 'The date given'} (${when}) is ${d === 0 ? 'today' : `${plural(d, 'day')} away`}.`,
      why: f.dueEstimated ? 'The date is an estimate: CareBridge added the time span in the document to the date of the document. It may not match what your clinic booked.' : 'The document gives a specific date.',
      nextStep: NEXT.followup, question: `Can you confirm the timing for "${clip(f.action, 90)}" and who will arrange it?`, sources: f.sources,
    });
  }

  // 3. follow-ups buried at the end of long documents (one item per document)
  const buriedBy = new Map();
  for (const f of an.followUps.filter((x) => x.buried)) {
    const id = f.sources[0]?.docId;
    if (!buriedBy.has(id)) buriedBy.set(id, []);
    buriedBy.get(id).push(f);
  }
  for (const [id, list] of buriedBy) {
    add('followups', {
      kind: 'buried_followup', priority: 'medium',
      title: `${plural(list.length, 'follow-up instruction')} on the last page of "${docName(id)}"`,
      summary: `${list.map((f) => f.action).join('; ')}.`,
      why: 'Instructions on the final page of a long document are the ones most often skipped.',
      nextStep: NEXT.followup, question: 'Can you walk me through the follow-up steps listed at the end of my discharge papers?', sources: list.flatMap((f) => f.sources),
    });
  }

  // 4. medication appears in some medication lists but not others
  const listKinds = new Set(['prescription', 'discharge_summary']);
  const listDocs = an.documents.filter((d) => listKinds.has(d.kind) && an.medications.some((m) => m.sources[0]?.docId === d.id));
  if (listDocs.length >= 2) {
    const groups = new Map();
    for (const m of an.medications) {
      if (m.action === 'stop' || m.action === 'avoid') continue;
      const k = m.key;
      if (!groups.has(k)) groups.set(k, { name: m.name, docs: new Set(), sources: [] });
      const g = groups.get(k);
      if (listDocs.some((d) => d.id === m.sources[0]?.docId)) g.docs.add(m.sources[0].docId);
      g.sources.push(...m.sources);
    }
    for (const g of groups.values()) {
      if (g.docs.size === 0 || g.docs.size === listDocs.length) continue;
      const missingIn = listDocs.filter((d) => !g.docs.has(d.id)).map((d) => `"${d.name}"`);
      const presentIn = listDocs.filter((d) => g.docs.has(d.id)).map((d) => `"${d.name}"`);
      add('meds', {
        kind: 'medication_list_mismatch', priority: 'medium',
        title: `${g.name} is on one medication list but not another`,
        summary: `${g.name} appears in ${presentIn.join(' and ')} but not in ${missingIn.join(' or ')}.`,
        why: 'A medicine can be missing from a later list because it was stopped, replaced, or simply left off. The documents do not say which.',
        nextStep: NEXT.conflict, question: `Is ${g.name} still part of my current medication list?`, sources: g.sources.slice(0, 3),
      });
    }
  }

  // 5. medications with no schedule
  const byKey = new Map();
  for (const m of an.medications) {
    if (!byKey.has(m.key)) byKey.set(m.key, []);
    byKey.get(m.key).push(m);
  }
  for (const list of byKey.values()) {
    if (list.every((m) => m.perDay === null && !m.asNeeded && m.action !== 'stop' && m.action !== 'avoid')) {
      add('meds', {
        kind: 'incomplete_instruction', priority: 'low', title: `No schedule found for ${list[0].name}`,
        summary: `The document names ${list[0].name} but the passage does not say how often to take it.`,
        why: 'The schedule may be written elsewhere, or it may be missing from this copy.', nextStep: NEXT.gap,
        question: `Can you confirm the schedule for ${list[0].name}?`, sources: list[0].sources,
      });
    }
  }

  // 6. documents without a readable date
  for (const d of an.documents.filter((x) => !x.date)) {
    const src = docs.find((x) => x.id === d.id);
    add('dates', {
      kind: 'undated_document', priority: 'low', title: `No date found on "${d.name}"`,
      summary: 'Without a date, this document cannot be placed on the timeline and follow-up dates inside it cannot be calculated.',
      why: 'The date may be in a part of the page that could not be read.', nextStep: NEXT.info, question: '',
      sources: [{ docId: d.id, page: src?.pages[0]?.page || 1, quote: clip(src?.pages[0]?.text.split('\n').find((l) => l.trim().length > 10) || '', 80) }],
    });
  }

  // 7. text that was read from images
  for (const d of an.documents.filter((x) => x.origin === 'ocr' || x.origin === 'image-ai' || (x.ocrConfidence !== null && x.ocrConfidence < 85))) {
    const src = docs.find((x) => x.id === d.id);
    add('quality', {
      kind: 'image_text', priority: 'low', title: `"${d.name}" was read from an image`,
      summary: 'Doses, dates and test values can be misread when text is taken from a photo or scan.',
      why: d.ocrConfidence !== null ? `The reader reported ${d.ocrConfidence}% confidence.` : 'Image reading is never perfect.', nextStep: NEXT.info, question: '',
      sources: [{ docId: d.id, page: src?.pages[0]?.page || 1, quote: clip(src?.pages[0]?.text.split('\n').find((l) => l.trim().length > 10) || '', 80) }],
    });
  }

  // 8. warning signs stated in the documents
  if (an.warningSigns.length) {
    add('warnings', {
      kind: 'warning_signs', priority: 'medium', title: 'Your documents list warning signs',
      summary: 'They describe symptoms that should prompt you to contact a clinician or seek urgent care.',
      why: 'This advice is usually written at the end of a document and rarely repeated.', nextStep: NEXT.warning,
      question: 'Which symptoms in my papers should make me contact you or seek urgent care?', sources: an.warningSigns.flatMap((w) => w.sources).slice(0, 4),
    });
  }
  return items;
}

async function aiSecondReader(docs, an, cfg, opts) {
  const context = {
    medications: an.medications.slice(0, 40).map((m) => `${m.name} ${m.doseText || ''} ${m.frequencyText || ''} (${m.sources[0]?.docName}, p.${m.sources[0]?.page})`.replace(/\s+/g, ' ')),
    followUps: an.followUps.slice(0, 30).map((f) => `${f.action}${f.timeframeText ? ` [${f.timeframeText}]` : ''}`),
    flaggedResults: an.results.filter((r) => r.flagged).slice(0, 30).map((r) => `${r.test} ${r.value} ${r.unit || ''} (${r.flag})`),
    issuesAlreadyReported: an.findings.slice(0, 40).map((f) => f.title),
  };
  return coerceMissing(await callJson(cfg, missingPrompt(docs, context), opts));
}

export function summarizeChecks(items, an, aiState) {
  const count = (c) => items.filter((i) => i.check === c).length;
  const conflicts = an.findings.filter((f) => f.kind === 'medication_conflict').length;
  return [
    { id: 'meds', label: 'Medication instructions compared across documents', detail: `${plural(an.medications.length, 'medication mention')} checked`, count: conflicts + count('meds') },
    { id: 'followups', label: 'Follow-ups and repeat tests', detail: `${plural(an.followUps.length, 'follow-up')} found`, count: count('followups') },
    { id: 'results', label: 'Flagged results matched to instructions', detail: `${plural(an.results.filter((r) => r.flagged).length, 'flagged result')} checked`, count: count('results') },
    { id: 'dates', label: 'Dates and deadlines', detail: 'Due dates calculated from document dates', count: count('dates') },
    { id: 'warnings', label: 'Warning signs written in your documents', detail: `${plural(an.warningSigns.length, 'passage')} found`, count: count('warnings') },
    { id: 'quality', label: 'Reading quality of photos and scans', detail: 'Image-based text is flagged for double-checking', count: count('quality') },
    aiState.ran
      ? { id: 'ai', label: 'Second reading by the AI model', detail: 'Every quote it returned was checked against your documents', count: aiState.count }
      : { id: 'ai', label: 'Second reading by the AI model', detail: aiState.reason, count: 0, skipped: true },
  ].map((c) => ({ ...c, status: c.skipped ? 'skipped' : c.count ? 'review' : 'clear' }));
}

export async function runMissing({ docs, an, cfg, today, now = new Date(), opts = {} }) {
  const items = deterministicChecks(docs, an, today);
  let notice = null;
  const aiState = { ran: false, count: 0, reason: 'No AI model is configured; rules-based checks only.' };

  if (cfg.ai.provider !== 'none') {
    try {
      const found = await aiSecondReader(docs, an, cfg, opts);
      aiState.ran = true;
      let k = 0;
      for (const it of found) {
        const sources = reverify(docs, it.sources);
        const title = safeText(it.title, 140);
        const explanation = safeText(it.explanation, 420);
        if (!sources.length || !title || !explanation) continue;
        if (items.some((x) => matchKey(x.title) === matchKey(title) || sources.every((s) => x.sources.some((y) => matchKey(y.quote).includes(matchKey(s.quote)) || matchKey(s.quote).includes(matchKey(y.quote)))))) continue;
        items.push({ id: `a${++k}`, check: 'ai', origin: 'ai', kind: 'ai_review', priority: it.priority, title, summary: explanation, why: safeText(it.why, 300) || 'An AI reader flagged this on a second pass. CareBridge confirmed that the quotes exist in your documents; the point itself is a suggestion to verify.', nextStep: NEXT.gap, question: safeText(it.question, 200) || '', sources });
      }
      aiState.count = k;
    } catch (e) {
      if (!cfg.fallbackToRules) throw e;
      aiState.reason = 'The AI model was unavailable, so only rules-based checks ran.';
      notice = 'The AI second reading could not run. These results come from CareBridge\'s built-in checks.';
    }
  }
  items.sort((a, b) => RANK[a.priority] - RANK[b.priority] || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return {
    items, checks: summarizeChecks(items, an, aiState), mode: aiState.ran ? 'ai' : 'rules', notice,
    generatedAt: now.toISOString(), documentCount: docs.length, pageCount: docs.reduce((s, d) => s + d.pages.length, 0),
  };
}
