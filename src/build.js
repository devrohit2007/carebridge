// The core of CareBridge. Takes a "raw extraction" (from the AI and/or the rules engine) and turns it into a
// verified, source-linked analysis. Anything that is a claim about the documents is checked here, in code:
//  - every quote must exist in the cited document (otherwise the item is dropped),
//  - medication conflicts are detected deterministically (the model never "decides" a conflict),
//  - follow-up due dates and range checks are computed, not guessed,
//  - model-written text passes a safety filter, and "next steps" are fixed text.
import { VERSION } from './config.js';
import { buildBrief, briefToText, fmtDate } from './brief.js';
import {
  addInterval, clip, daysBetween, drugAliases, findDates, isoOrNull, matchKey, parseDose, parseFrequency, parseRange,
  quoteInText, rangeStatus, relativeFromText, sameFrequency, upperFirst,
} from './normalize.js';
import { detectKind, guessDocDate, kindLabel } from './rules.js';
import { NEXT, findWarningSigns, safeText } from './safety.js';

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const ACTION_LABEL = { start: 'New', continue: 'Continue', stop: 'Stop', change: 'Change', avoid: 'Avoid' };
const uniq = (a) => [...new Set(a)];
const VISIT_RE = /^\W*(?:review|follow[\s-]?up|appointment|consult\w*|see\b|visit|return|come back|re-?visit)/i;
const TEST_RE = /\b(?:repeat|re-?test|re-?check|test|scan|x-?ray|mri|ultrasound)\b/i;
const followQuestion = (action) => (VISIT_RE.test(action) && !/\brepeat\b/i.test(action)
  ? 'When should my follow-up appointment be, and who books it?'
  : TEST_RE.test(action) ? 'When should I repeat the test, and who will order it?'
    : `Can you confirm the timing for "${clip(action, 90)}" and who will arrange it?`);
const doctorName = (q) => (String(q).match(/\bDr\.?\s+([A-Z][a-z]+)/) || [])[1]?.toLowerCase();
// "hemoglobin" -> "Hemoglobin", but leave "eGFR" and "HbA1c" alone
const testName = (t) => { const x = clip(t, 60); return /^[a-z][a-z\s]*$/.test(x) ? upperFirst(x) : x; };

// ---------- sources ----------
export function verifySource(docs, docId, pageNo, quote) {
  const q = clip(quote, 240).replace(/^(?:[-*\u2022]|\d{1,2}[.)])\s+/, '');
  const mk = (d, p, verified) => ({ docId: d.id, docName: d.name, page: p, unit: d.unit, quote: q, verified });
  const byId = docs.find((d) => d.id === docId);
  if (q) {
    if (byId) {
      const pg = byId.pages.find((p) => p.page === Number(pageNo));
      if (pg && quoteInText(q, pg.text)) return mk(byId, pg.page, true);
      const other = byId.pages.find((p) => quoteInText(q, p.text));
      if (other) return mk(byId, other.page, true);
    }
    for (const d of docs) {
      const p = d.pages.find((x) => quoteInText(q, x.text));
      if (p) return mk(d, p.page, true);
    }
  }
  const d = byId || docs[0];
  return mk(d, d.pages.find((p) => p.page === Number(pageNo))?.page ?? d.pages[0]?.page ?? 1, false);
}

const overlap = (a, b) => {
  const x = matchKey(a);
  const y = matchKey(b);
  if (x.length < 8 || y.length < 8) return x === y;
  return x.includes(y) || y.includes(x);
};

/** Union of the AI extraction and the rules extraction (recall safety-net). Duplicates are removed by overlapping quote. */
export function mergeRaw(primary, extra) {
  const out = { ...primary };
  for (const k of ['medications', 'followUps', 'results', 'instructions']) {
    const have = [...primary[k]];
    for (const e of extra[k]) if (!have.some((h) => h.docId === e.docId && overlap(h.quote, e.quote))) have.push(e);
    out[k] = have;
  }
  const events = [...primary.events];
  for (const e of extra.events) if (!events.some((h) => h.docId === e.docId && (h.date === e.date || overlap(h.quote, e.quote)))) events.push(e);
  out.events = events;
  out.documents = primary.documents.length ? primary.documents : extra.documents;
  return out;
}

// ---------- medications ----------
function freqPhrase(e) {
  const p = e.perDay;
  if (p === null || p === undefined) return e.asNeeded ? 'as needed' : e.frequencyText || null;
  let t;
  if (sameFrequency(p, 1)) t = 'once daily';
  else if (sameFrequency(p, 2)) t = 'twice daily';
  else if (sameFrequency(p, 3)) t = 'three times daily';
  else if (sameFrequency(p, 4)) t = 'four times daily';
  else if (sameFrequency(p, 0.5)) t = 'every other day';
  else if (sameFrequency(p, 2 / 7)) t = 'twice weekly';
  else if (sameFrequency(p, 1 / 7)) t = 'once weekly';
  else t = `${Math.round(p * 10) / 10} times a day`;
  return e.asNeeded ? `${t}, as needed` : t;
}

const medValue = (e) => [ACTION_LABEL[e.action], e.doseText, freqPhrase(e)].filter(Boolean).join(' ') || e.sources[0].quote;

function groupMeds(meds) {
  const parent = meds.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = new Map();
  meds.forEach((m, i) => {
    for (const k of m.aliases) {
      if (seen.has(k)) parent[find(i)] = find(seen.get(k));
      else seen.set(k, i);
    }
  });
  const groups = new Map();
  meds.forEach((m, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  });
  return [...groups.values()];
}

const isStop = (e) => e.action === 'stop' || e.action === 'avoid';

function conflictReasons(group) {
  const reasons = [];
  const freqs = group.filter((e) => e.perDay !== null && !e.asNeeded && !isStop(e)).map((e) => e.perDay);
  if (freqs.some((f) => !sameFrequency(f, freqs[0]))) reasons.push('how often it is taken');
  const byUnit = new Map();
  for (const e of group.filter((x) => x.dose && !isStop(x))) {
    if (!byUnit.has(e.dose.unit)) byUnit.set(e.dose.unit, []);
    byUnit.get(e.dose.unit).push(e.dose.amount);
  }
  for (const list of byUnit.values()) {
    if (list.some((a) => Math.abs(a - list[0]) > 1e-9 * Math.max(1, a, list[0]))) {
      reasons.push('the dose or strength');
      break;
    }
  }
  const active = group.some((e) => ['start', 'continue', 'change'].includes(e.action) || (e.action === 'mention' && (e.perDay !== null || e.dose)));
  if (group.some(isStop) && active) reasons.push('whether it should be taken');
  return reasons;
}

// ---------- the main builder ----------
export function buildAnalysis(docs, raw, ctx) {
  const { mode, provider = 'none', model = '', today, notice = null, now = new Date() } = ctx;
  const counters = {};
  const nid = (p) => `${p}${(counters[p] = (counters[p] || 0) + 1)}`;
  const dropped = { unverified: 0, unsafe: 0 };
  const origin = mode === 'ai' ? 'ai' : 'rules';
  const docById = new Map(docs.map((d) => [d.id, d]));
  const safe = (t, max) => {
    const s = safeText(t, max);
    if (s === null) {
      dropped.unsafe++;
      return '';
    }
    return s;
  };
  const verified = (r) => {
    const s = verifySource(docs, r.docId, r.page, r.quote);
    if (!s.verified) dropped.unverified++;
    return s;
  };

  // documents
  const documents = docs.map((d) => {
    const r = raw.documents.find((x) => x.docId === d.id) || {};
    const text = d.pages.map((p) => p.text).join('\n');
    const guess = guessDocDate(d);
    const dateOk = r.date && findDates(text).some((x) => x.iso === r.date);
    const date = dateOk ? r.date : guess.iso;
    const kind = r.kind || detectKind(text, d.name);
    let datePage = d.pages[0]?.page ?? 1;
    if (date) {
      const hit = d.pages.find((p) => findDates(p.text).some((x) => x.iso === date));
      if (hit) datePage = hit.page;
    }
    return {
      id: d.id, name: d.name, kind, date, dateText: guess.text, datePage, provider: r.provider || null, pages: d.pages.length, unit: d.unit,
      origin: d.origin, ocrConfidence: d.ocrConfidence, summary: safe(r.summary, 200),
    };
  });
  const docMeta = new Map(documents.map((d) => [d.id, d]));

  // medications
  const meds = [];
  for (const r of raw.medications) {
    const source = verified(r);
    if (!source.verified || !r.name) continue;
    const f1 = parseFrequency(r.frequency || '');
    const f = f1.perDay !== null || f1.asNeeded ? f1 : parseFrequency(r.quote);
    const dose = parseDose(r.dose || '') || parseDose(r.quote);
    const aliases = drugAliases(r.name);
    if (!aliases.length) continue;
    meds.push({
      id: nid('m'), key: aliases[0], aliases, name: upperFirst(clip(r.name, 60)), action: r.action,
      doseText: dose ? dose.text : r.dose, dose, frequencyText: null, perDay: f.perDay, asNeeded: f.asNeeded || r.action === 'as_needed',
      duration: r.duration, rawFrequency: r.frequency || f.label, sources: [source],
    });
  }

  for (const m of meds) m.frequencyText = freqPhrase({ perDay: m.perDay, asNeeded: m.asNeeded, frequencyText: m.rawFrequency });

  // conflicts
  const findings = [];
  for (const group of groupMeds(meds)) {
    if (group.length < 2) continue;
    const reasons = conflictReasons(group);
    if (!reasons.length) continue;
    const seen = new Set();
    const compare = [];
    for (const e of group) {
      const sig = `${e.perDay === null ? '' : e.perDay.toFixed(2)}|${e.dose ? e.dose.amount + e.dose.unit : ''}|${isStop(e) ? 'stop' : 'go'}`;
      if (seen.has(sig) || compare.length >= 4) continue;
      seen.add(sig);
      const s = e.sources[0];
      compare.push({ docId: s.docId, label: s.docName, page: s.page, unit: s.unit, dateText: docMeta.get(s.docId)?.date || null, value: medValue(e), quote: s.quote });
    }
    if (compare.length < 2) continue;
    const name = group[0].name;
    const docCount = uniq(group.map((e) => e.sources[0].docId)).length;
    const dates = uniq(compare.map((c) => c.dateText).filter(Boolean));
    const id = nid('n');
    group.forEach((e) => { e.conflictId = id; });
    findings.push({
      id, category: 'verify', kind: 'medication_conflict', priority: 'high', origin: 'rules',
      title: `Potential instruction conflict: ${name}`,
      summary: `Potential instruction conflict detected. ${docCount === 1 ? 'This document contains' : docCount === 2 ? 'Two documents contain' : 'Several documents contain'} different instructions for the same medication. Please confirm the current instruction with your doctor or pharmacist.`,
      why: `The statements all mention ${name}, but they differ in ${reasons.join(' and ')}. CareBridge compares what each document states; it does not decide which one is correct.${dates.length > 1 ? ' The documents carry different dates, so one may be an update - that is something to confirm, not assume.' : ''}`,
      nextStep: NEXT.conflict,
      question: clip(`Which instruction for ${name} is the current one: ${compare.slice(0, 3).map((c) => c.value.toLowerCase()).join(' or ')}?`, 200),
      compare, sources: compare.map((c) => verifySource(docs, c.docId, c.page, c.quote)),
    });
  }

  // follow-ups
  const followUps = [];
  for (const r of raw.followUps) {
    const source = verified(r);
    if (!source.verified) continue;
    const meta = docMeta.get(source.docId);
    const action = safe(r.action, 160) || clip(r.quote, 140);
    let dueDate = null;
    let dueEstimated = false;
    const pageText = docById.get(source.docId)?.pages.find((p) => p.page === source.page)?.text || '';
    if (r.dueDate && findDates(pageText).some((d) => d.iso === r.dueDate)) dueDate = r.dueDate;
    const rel = r.relative && r.relative.unit ? r.relative : relativeFromText(r.timeframeText || r.quote);
    if (!dueDate && rel && meta?.date) {
      dueDate = addInterval(meta.date, rel.amount, rel.unit);
      dueEstimated = Boolean(dueDate);
    }
    const days = dueDate ? daysBetween(today, dueDate) : null;
    const status = days === null ? 'undated' : days < 0 ? 'overdue' : days <= 14 ? 'soon' : 'upcoming';
    const buried = meta ? source.page === (docById.get(source.docId).pages.at(-1)?.page) && meta.pages >= 3 : false;
    const why = [safe(r.whyEasyToMiss, 200), buried ? 'It appears on the last page of a multi-page document.' : '', /\b(if|unless|as needed|when)\b/i.test(r.quote) ? 'It is worded conditionally.' : '',
      status === 'overdue' ? 'The date calculated from the document may already have passed.' : '', status === 'soon' ? 'The calculated date is within the next two weeks.' : '']
      .filter(Boolean).join(' ') || 'Follow-up instructions are easy to overlook, especially when they sit inside longer documents.';
    followUps.push({ id: nid('f'), action: upperFirst(action), timeframeText: r.timeframeText || rel?.text || null, dueDate, dueEstimated, daysUntil: days, status, buried, whyEasyToMiss: why, sources: [source] });
  }
  const order = { overdue: 0, soon: 1, upcoming: 2, undated: 3 };
  followUps.sort((a, b) => order[a.status] - order[b.status] || (a.dueDate || '9').localeCompare(b.dueDate || '9'));
  // two documents asking for a visit at different times
  const visits = followUps.filter((f) => VISIT_RE.test(f.action) && !/\brepeat\b/i.test(f.action) && !TEST_RE.test(f.action.split(/\bwith\b/i)[0]));
  const differing = [];
  for (const f of visits) {
    if (differing.some((g) => g.sources[0].docId === f.sources[0].docId)) continue;
    const other = differing[0];
    if (!other) { differing.push(f); continue; }
    const [n1, n2] = [doctorName(other.sources[0].quote), doctorName(f.sources[0].quote)];
    const far = other.dueDate && f.dueDate ? Math.abs(daysBetween(other.dueDate, f.dueDate)) > 3 : other.timeframeText && f.timeframeText && matchKey(other.timeframeText) !== matchKey(f.timeframeText);
    if (far && !(n1 && n2 && n1 !== n2)) differing.push(f);
  }
  if (differing.length >= 2) {
    const tf = (f) => f.timeframeText || (f.dueDate ? `around ${fmtDate(f.dueDate)}` : 'time not stated');
    findings.push({
      id: nid('n'), category: 'verify', kind: 'followup_difference', priority: 'medium', origin: 'rules',
      title: `Different follow-up timing: ${differing.slice(0, 3).map(tf).join(' vs ')}`,
      summary: `Potential timing difference detected. ${differing.length === 2 ? 'Two documents ask' : 'Several documents ask'} for a follow-up visit at different times. Please confirm with your clinic which one applies.`,
      why: 'Each passage describes a review or follow-up visit, but the timing differs. A later document may be an update; CareBridge cannot tell, so it is raised for you to confirm.',
      nextStep: NEXT.followup, question: `Which follow-up timing applies: ${differing.slice(0, 3).map(tf).join(' or ')}?`,
      compare: differing.slice(0, 3).map((f) => { const s0 = f.sources[0]; return { docId: s0.docId, label: s0.docName, page: s0.page, unit: s0.unit, dateText: docMeta.get(s0.docId)?.date || null, value: `${tf(f)}${f.dueDate && f.timeframeText ? ` (about ${fmtDate(f.dueDate)})` : ''}`, quote: s0.quote }; }),
      sources: differing.slice(0, 3).map((f) => f.sources[0]),
    });
  }

  for (const f of followUps) {
    const when = f.dueDate ? `${f.dueEstimated ? 'Estimated around' : 'Date given:'} ${fmtDate(f.dueDate)}${f.dueEstimated ? ' (calculated from the date on the document)' : ''}.` : f.timeframeText ? `Timing mentioned: ${f.timeframeText}.` : 'No timing was found.';
    findings.push({
      id: nid('n'), category: 'followup', kind: 'followup', priority: f.status === 'overdue' || f.status === 'soon' ? 'high' : 'medium', origin: 'rules', refId: f.id,
      title: f.action, summary: when, why: f.whyEasyToMiss, nextStep: NEXT.followup,
      question: followQuestion(f.action), sources: f.sources,
    });
  }

  // results
  const results = [];
  const flagMap = (x) => {
    const s = String(x ?? '').trim().toUpperCase();
    if (/^(H|HH|HIGH)$/.test(s)) return 'high';
    if (/^(L|LL|LOW)$/.test(s)) return 'low';
    if (/^(CRIT|CRITICAL|ABNORMAL|ABN|A|\*+)$/.test(s)) return 'abnormal';
    return null;
  };
  for (const r of raw.results) {
    const source = verified(r);
    if (!source.verified || !r.test || !r.value) continue;
    const printed = flagMap(r.flag);
    const calc = rangeStatus(r.value, parseRange(r.range));
    const flag = printed || (calc && calc !== 'in' ? calc : null);
    results.push({ id: nid('r'), test: testName(r.test), value: r.value, unit: r.unit, range: r.range, flag, flagSource: printed ? 'document' : flag ? 'range-check' : null, printedFlag: r.flag, flagged: Boolean(flag), sources: [source] });
  }
  for (const r of results.filter((x) => x.flagged)) {
    const label = r.flag === 'high' ? 'high' : r.flag === 'low' ? 'low' : 'abnormal';
    findings.push({
      id: nid('n'), category: 'flagged', kind: 'flagged_result', priority: 'medium', origin: 'rules', refId: r.id,
      title: `${r.test} ${r.value}${r.unit ? ` ${r.unit}` : ''}`,
      summary: `${r.flagSource === 'document' ? `The report marks this value as ${label}` : 'This value is outside the reference range printed in the report'}${r.range ? ` (printed reference range: ${r.range})` : ''}.`,
      why: r.flagSource === 'document'
        ? `The report itself carries the flag "${r.printedFlag}". CareBridge only repeats what the report prints; it does not interpret results.`
        : `CareBridge compared the number with the reference range printed in the report. The report itself does not mark this value. This is arithmetic, not a medical judgement.`,
      nextStep: NEXT.flagged, question: `Is the flagged ${r.test} result something I should discuss at my follow-up?`, sources: r.sources, flagLabel: label,
    });
  }

  // warning signs stated by the documents
  const warningSigns = findWarningSigns(docs).map((w) => ({ id: nid('w'), text: w.quote, sources: [verifySource(docs, w.docId, w.page, w.quote)] }));
  for (const w of warningSigns) {
    findings.push({
      id: nid('n'), category: 'warning', kind: 'warning_sign', priority: 'medium', origin: 'rules', refId: w.id,
      title: `Warning signs listed in "${w.sources[0].docName}"`, summary: 'The document lists symptoms that should prompt you to seek care.',
      why: 'Documents often place urgent-care advice at the very end. CareBridge shows it so you can find it quickly. It does not assess whether anything applies to you.', nextStep: NEXT.warning,
      question: 'Which symptoms in my discharge papers should make me contact you or seek urgent care?', sources: w.sources,
    });
  }

  // instructions
  const instructions = [];
  for (const r of raw.instructions) {
    const source = verified(r);
    if (!source.verified) continue;
    instructions.push({ id: nid('i'), text: safe(r.text, 220) || clip(r.quote, 200), sources: [source] });
  }

  // AI-reported discrepancies (every quote is checked; at least one must be real)
  for (const it of raw.issues) {
    const sources = it.sources.map((s) => verifySource(docs, s.docId, s.page, s.quote)).filter((s) => s.verified);
    if (!sources.length) {
      dropped.unverified++;
      continue;
    }
    const title = safe(it.title, 140);
    const explanation = safe(it.explanation, 420);
    if (!title || !explanation) continue;
    if (findings.some((f) => (f.kind === 'medication_conflict' || f.kind === 'followup_difference') && sources.every((s) => f.sources.some((x) => overlap(x.quote, s.quote))))) continue;
    findings.push({
      id: nid('n'), category: 'verify', kind: 'discrepancy', priority: 'medium', origin: 'ai', title: `Potential issue: ${title}`, summary: explanation,
      why: 'An AI reader noticed these passages and flagged them. CareBridge checked that each quote exists in your documents, but the comparison itself is a suggestion - please verify it.',
      nextStep: NEXT.conflict, question: safe(it.question, 200) || 'Can you help me understand why my documents differ on this point?',
      compare: sources.slice(0, 3).map((s) => ({ docId: s.docId, label: s.docName, page: s.page, unit: s.unit, dateText: docMeta.get(s.docId)?.date || null, value: clip(s.quote, 90), quote: s.quote })), sources,
    });
  }

  // timeline
  const timeline = [];
  const pageHas = (docId, page, iso) => findDates(docById.get(docId)?.pages.find((p) => p.page === page)?.text || '').some((d) => d.iso === iso);
  for (const r of raw.events) {
    const source = verified(r);
    if (!source.verified) continue;
    const fromQuote = findDates(r.quote).find((d) => d.iso);
    const date = r.date && pageHas(source.docId, source.page, r.date) ? r.date : fromQuote ? fromQuote.iso : null;
    const label = safe(r.label, 100);
    if (!label) continue;
    timeline.push({ id: nid('e'), date, dateText: r.dateText || fromQuote?.text || null, label: upperFirst(label), category: r.category, estimated: false, sources: [source] });
  }
  for (const d of documents) {
    if (!d.date || timeline.some((e) => e.sources[0].docId === d.id && e.date === d.date)) continue;
    const q = d.dateText && quoteInText(d.dateText, docById.get(d.id).pages.map((p) => p.text).join('\n')) ? d.dateText : null;
    if (!q) continue;
    timeline.push({ id: nid('e'), date: d.date, dateText: d.dateText, label: `${kindLabel(d.kind)}${d.provider ? ` by ${d.provider}` : ''}`, category: d.kind === 'lab_report' ? 'test' : 'visit', estimated: false, sources: [verifySource(docs, d.id, d.datePage, q)] });
  }
  for (const f of followUps) {
    if (f.dueDate) timeline.push({ id: nid('e'), date: f.dueDate, dateText: null, label: `Follow-up: ${clip(f.action, 80)}`, category: 'followup', estimated: f.dueEstimated, status: f.status, sources: f.sources });
  }
  timeline.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  // questions: most important first, no duplicates, never a diagnosis or dose suggestion
  const questions = [];
  const addQ = (text, findingId) => {
    const t = safe(text, 220);
    if (t && !questions.some((q) => matchKey(q.text) === matchKey(t))) questions.push({ id: nid('q'), text: t.endsWith('?') ? t : `${t}?`, findingId: findingId || null });
  };
  const rank = { verify: 0, followup: 1, flagged: 2, warning: 3 };
  [...findings].sort((a, b) => rank[a.category] - rank[b.category]).forEach((f) => addQ(f.question, f.id));
  raw.questions.forEach((q) => addQ(q));
  questions.length = Math.min(questions.length, 12);

  const flaggedCount = results.filter((r) => r.flagged).length;
  const kinds = uniq(documents.map((d) => d.kind.replace(/_/g, ' ')));
  const summary = safe(raw.summary, 400) ||
    `${docs.length} document${docs.length === 1 ? '' : 's'} analyzed (${kinds.join(', ')}). CareBridge found ${meds.length} medication mention${meds.length === 1 ? '' : 's'}, ${followUps.length} follow-up${followUps.length === 1 ? '' : 's'} and ${flaggedCount} flagged result${flaggedCount === 1 ? '' : 's'}.`;

  const analysis = {
    meta: {
      version: VERSION, mode, provider, model, generatedAt: now.toISOString(), today, documentCount: docs.length,
      pageCount: docs.reduce((n, d) => n + d.pages.length, 0), notice, dropped,
    },
    documents, medications: meds.map(({ aliases, dose, rawFrequency, ...m }) => m), instructions, timeline, followUps, results, warningSigns, findings, questions, summary,
  };
  analysis.brief = buildBrief(analysis);
  analysis.briefText = briefToText(analysis.brief);
  return analysis;
}
