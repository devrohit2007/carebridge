// Doctor Visit Brief: built in code from the verified analysis, so it is fast, consistent and cannot add new claims.
import { DISCLAIMER, EMERGENCY } from './safety.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : '';
}
const ref = (s) => `${s.docName}, ${s.unit === 'section' ? 'section' : 'p.'} ${s.page}`;

export function buildBrief(a) {
  const meds = new Map();
  for (const m of a.medications) {
    const k = m.conflictId || m.key;
    if (!meds.has(k)) meds.set(k, { name: m.name, conflict: Boolean(m.conflictId), entries: [] });
    const g = meds.get(k);
    const value = [m.doseText, m.frequencyText].filter(Boolean).join(', ');
    g.entries.push({ value: value || m.sources[0].quote, action: m.action, source: ref(m.sources[0]) });
  }
  const when = (f) => (f.dueDate ? `${f.dueEstimated ? 'around ' : ''}${fmtDate(f.dueDate)}${f.dueEstimated ? ' (estimated)' : ''}` : f.timeframeText || 'timing not stated');
  return {
    title: 'Doctor Visit Brief',
    preparedOn: a.meta.today,
    disclaimer: DISCLAIMER,
    emergency: EMERGENCY,
    documents: a.documents.map((d) => ({ name: d.name, kind: d.kind, date: d.date, pages: d.pages, unit: d.unit })),
    summary: a.summary,
    medications: [...meds.values()],
    needsVerification: a.findings
      .filter((f) => f.category === 'verify')
      .map((f) => ({ title: f.title, summary: f.summary, statements: (f.compare || []).map((c) => ({ label: c.label, page: c.page, unit: c.unit, value: c.value })) })),
    followUps: a.followUps.map((f) => ({ action: f.action, when: when(f), status: f.status, source: ref(f.sources[0]) })),
    flaggedResults: a.results.filter((r) => r.flagged).map((r) => ({ test: r.test, value: `${r.value}${r.unit ? ` ${r.unit}` : ''}`, range: r.range, flag: r.flag, flagSource: r.flagSource, source: ref(r.sources[0]) })),
    instructions: a.instructions.slice(0, 8).map((i) => ({ text: i.text, source: ref(i.sources[0]) })),
    warningSigns: a.warningSigns.map((w) => ({ text: w.text, source: ref(w.sources[0]) })),
    questions: a.questions.slice(0, 8).map((q) => q.text),
  };
}

export function briefToText(b) {
  const L = [];
  const section = (t) => L.push('', t.toUpperCase());
  L.push('DOCTOR VISIT BRIEF', `Prepared ${fmtDate(b.preparedOn)} with CareBridge from ${b.documents.length} document${b.documents.length === 1 ? '' : 's'} supplied by the patient.`, b.disclaimer);
  section('Documents reviewed');
  b.documents.forEach((d) => L.push(`- ${d.name}${d.date ? ` (dated ${fmtDate(d.date)})` : ''}, ${d.pages} ${d.unit}${d.pages === 1 ? '' : 's'}`));
  if (b.needsVerification.length) {
    section('Needs verification');
    b.needsVerification.forEach((n) => {
      L.push(`- ${n.title}`);
      n.statements.forEach((s) => L.push(`    ${s.label}, ${s.unit === 'section' ? 'section' : 'p.'} ${s.page}: ${s.value}`));
    });
  }
  if (b.medications.length) {
    section('Medications as written in the documents');
    b.medications.forEach((m) => L.push(`- ${m.name}${m.conflict ? ' [documents differ - please verify]' : ''}`, ...m.entries.map((e) => `    ${e.value} (${e.source})`)));
  }
  if (b.followUps.length) {
    section('Follow-ups mentioned');
    b.followUps.forEach((f) => L.push(`- ${f.action} - ${f.when} (${f.source})`));
  }
  if (b.flaggedResults.length) {
    section('Results flagged or outside the printed range');
    b.flaggedResults.forEach((r) => L.push(`- ${r.test}: ${r.value}${r.range ? ` (printed range ${r.range})` : ''} (${r.source})`));
  }
  if (b.warningSigns.length) {
    section('Warning signs the documents mention');
    b.warningSigns.forEach((w) => L.push(`- ${w.text} (${w.source})`));
    L.push(b.emergency);
  }
  if (b.questions.length) {
    section('Questions to ask');
    b.questions.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  }
  L.push('', 'Every item above comes from the patient\'s own documents and should be verified against the originals.');
  return L.join('\n');
}
