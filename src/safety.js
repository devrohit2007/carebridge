// Safety layer. Two jobs:
//  1. Reject model-written text that diagnoses, prescribes, reassures or tells people to change medication.
//  2. Surface warning signs that the DOCUMENTS themselves state (we never invent urgency).
// Quotes copied from documents are never filtered: they are shown as "The document states...".
import { clip, matchKey } from './normalize.js';

export const DISCLAIMER =
  'CareBridge is an information and care-coordination tool. It does not diagnose conditions, prescribe medicines, or replace your doctor or pharmacist.';
export const EMERGENCY = 'If you think you may be having a medical emergency, call your local emergency number or go to the nearest emergency department now.';

// Next steps are fixed text on purpose: the model never writes them.
export const NEXT = {
  conflict: 'Please confirm the current instruction with your doctor or pharmacist before changing anything.',
  followup: 'Check with your clinic whether this is already scheduled, or ask them when it should happen.',
  flagged: 'Consider discussing this result with your clinician at your follow-up.',
  gap: 'Please verify this with your clinician or pharmacist.',
  warning: EMERGENCY,
  info: 'Please verify against the original document.',
};

const UNSAFE = [
  [/\byou (?:likely |probably |possibly |may |might |could )?(?:have|has|suffer from|are suffering from) (?:a |an |the )?(?:diabetes|anou?emia|anaemia|cancer|hypertension|infection|kidney (?:disease|failure|damage)|liver (?:disease|damage)|heart (?:disease|failure|attack)|disease|disorder|condition|syndrome)\b/i, 'diagnosis'],
  [/\byou are (?:likely |probably )?(?:diabetic|anaemic|anemic|hypertensive|prediabetic|at risk of)\b/i, 'diagnosis'],
  [/\b(?:diagnos(?:is|ed) (?:of|with|as)|likely (?:due to|caused by)|because you have|sign of (?:a|an)\b|symptom of (?:a|an)\b)/i, 'diagnosis'],
  [/\b(?:this|that|it|these results?) (?:means|indicates|confirms|proves|suggests that you|shows that you)\b/i, 'interpretation'],
  [/(?:^|[.!?]\s+)(?:please\s+)?(?:stop|discontinue|skip|double|halve|increase|decrease|reduce|lower|raise|taper|swap|switch|change|start|begin|resume)\b[^.\n]{0,60}\b(?:medication|medicine|medicines|tablets?|pills?|doses?|dosage|drug|drugs|insulin)\b/i, 'medication change'],
  [/\byou (?:should|must|need to|ought to|can safely|may safely|can) (?:stop|discontinue|skip|double|halve|increase|decrease|reduce|lower|raise|swap|switch|change|start|begin|resume|take|continue)\b/i, 'medication change'],
  [/\b(?:take|use|give)\s+\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|tablets?|pills?|capsules?|units?)\b/i, 'dosing'],
  [/\b(?:safe|fine|okay|ok) to (?:stop|skip|take|combine|continue|ignore)\b/i, 'reassurance'],
  [/\b(?:nothing to worry|not serious|not a concern|no cause for concern|harmless|perfectly normal|is (?:completely )?normal|no need to (?:see|call|worry|consult))\b/i, 'reassurance'],
  [/\b(?:will recover|prognosis|life[- ]threatening|you will (?:be fine|get better))\b/i, 'prediction'],
];

/** Reasons a model-written string is not allowed (empty array = fine). */
export function unsafeReasons(text) {
  const t = String(text ?? '');
  const out = [];
  for (const [re, why] of UNSAFE) if (re.test(t) && !out.includes(why)) out.push(why);
  return out;
}

/** Returns the cleaned text, or null if it breaks a safety rule (caller decides what to do). */
export function safeText(text, max = 400) {
  const t = clip(text, max);
  if (!t) return '';
  return unsafeReasons(t).length ? null : t;
}

// ---- warning signs stated by the documents ----
const WARNING_RE = new RegExp(
  [
    String.raw`\b(?:seek|get|call for|go for)\s+(?:immediate|urgent|emergency|prompt)\b`,
    String.raw`\b(?:go to|return to|visit|report to|attend)\s+(?:the\s+|your\s+|a\s+)?(?:nearest\s+)?(?:emergency|er\b|a&e|casualty|hospital)`,
    String.raw`\bcall\s+(?:911|112|108|102|999|an ambulance|emergency|your doctor immediately)`,
    String.raw`\bemergency (?:room|department|services|care)\b`,
    String.raw`\bwarning signs?\b`,
    String.raw`\bred[- ]?flags?\b`,
    String.raw`\bchest pain\b`,
    String.raw`\b(?:difficulty|trouble) breathing\b|\bshortness of breath\b|\bbreathless`,
    String.raw`\bsevere (?:bleeding|pain|headache|vomiting|abdominal pain|allergic)`,
    String.raw`\bpersistent vomiting\b|\bvomiting blood\b|\bblack,? tarry stools?\b`,
    String.raw`\b(?:fainting|unconscious|seizures?|convulsions?)\b`,
    String.raw`\bswelling of (?:the )?(?:face|lips|tongue|throat)\b`,
    String.raw`\bhigh fever\b`,
  ].join('|'),
  'i',
);

const ABBREV = /(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|St|vs|approx|No|Fig|Tab|Cap|Syp|Inj|Susp|Oint)\.)(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\b\d{1,2}\.)(?<=[.!?])\s+(?=[A-Z0-9(])/;

/** Split text into readable units: headings and list items stay separate, wrapped lines are re-joined, sentences are split. */
export function textUnits(pageText) {
  const lines = String(pageText ?? '').split('\n').map((l) => l.trim());
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) for (const s of buf.split(ABBREV)) if (s.trim()) out.push(s.trim());
    buf = '';
  };
  lines.forEach((line, i) => {
    if (!line) return flush();
    const next = lines[i + 1] || '';
    const heading =
      line.split(/\s+/).length <= 4 && line.length <= 40 && !/[.!?,;:]$/.test(line) && /^[A-Z]/.test(line) && /^(?:[A-Z]|[-*\u2022]|\d{1,2}[.)])/.test(next);
    if (heading) {
      flush();
      out.push(line);
      return undefined;
    }
    if (/^(?:[-*\u2022]|\d{1,2}[.)])\s/.test(line) || /\s{2,}/.test(line) || /^[A-Z][A-Za-z/ ]{1,24}:\s/.test(line)) flush();
    buf = buf ? `${buf} ${line}` : line;
    return undefined;
  });
  flush();
  return out;
}

export function findWarningSigns(docs, limit = 6) {
  const out = [];
  const seen = new Set();
  for (const d of docs) {
    for (const p of d.pages) {
      for (const unit of textUnits(p.text)) {
        if (unit.split(/\s+/).length < 5 || !WARNING_RE.test(unit)) continue;
        const key = matchKey(unit);
        if (key.length < 12 || seen.has(key)) continue;
        seen.add(key);
        out.push({ docId: d.id, page: p.page, quote: clip(unit, 240) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
