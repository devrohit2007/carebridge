// Offline rules engine. Produces the same "raw extraction" shape as the AI extractor, using patterns only.
// It is a fallback for demos / no-internet / no-API-key, and a recall safety-net next to the AI.
// Every quote it returns is copied from the document text, so source checks always pass.
import { clip, findDates, parseDose, parseFrequency, relativeFromText, upperFirst, parseRange } from './normalize.js';
import { findWarningSigns, textUnits } from './safety.js';

const FORM = '(?:tab(?:let)?s?|cap(?:sule)?s?|syp|syrup|susp(?:ension)?|inj(?:ection)?|oint(?:ment)?|cream|gel|drops?|inhaler|sachet|patch)';
const ITEM = String.raw`(?:[-*\u2022]\s*|\d{1,2}[.)]\s*)?`;
const FORM_LINE = new RegExp(String.raw`^\s*${ITEM}${FORM}\b\.?\s+(.+)$`, 'i');
const DOSE_RE = String.raw`\d+(?:[.,]\d+)?\s?(?:mg|mcg|\u00b5g|ug|g|ml|iu|units?|%)`;
const DOSE_LINE = new RegExp(String.raw`^\s*${ITEM}([A-Z][A-Za-z-]{2,}(?:\s+[A-Za-z-]{2,}){0,2}?)\s+(${DOSE_RE})\b(.*)$`);
const TAKE = new RegExp(
  String.raw`\btake\s+(?:the\s+)?(?:(?:medicine|medication|drug|tablet|capsule)s?\s+)?([A-Za-z][\w'-]*(?:\s+${DOSE_RE})?)\s+((?:once|twice|thrice|three times|four times|\d+\s*(?:x|times)|every\s+\d+\s*hours?|daily|at (?:night|bedtime)|in the (?:morning|evening))\b.*)$`,
  'i',
);
const STOP_WORDS = new Set('once twice thrice daily take taken after before with without at for every in on as if when morning night evening bedtime tablet tablets tab cap capsule capsules by orally oral to the and or only x'.split(' '));

const FU_RE = /\b(?:follow[\s-]?up|review|revisit|re-?visit|return|come back|see (?:your |the )?(?:doctor|physician|gp|clinic|dr\.?)|appointment|consult(?:ation)?|repeat|re-?check|re-?test|retest|re-?evaluat\w*|next visit|book|schedule)\b/i;
const WHEN_RE = /\b(?:in|after|within|every|by|about|around)\s+(?:about\s+)?(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)(?:\s*(?:-|\u2013|to)\s*\d+)?\s*(?:day|week|month|year)s?\b|\bnext\s+(?:week|month|visit|year)\b|\btomorrow\b|\bnext\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i;
const INSTR_RE = /^(?:[-*\u2022]\s*|\d{1,2}[.)]\s*)?(?:avoid|do not|don't|never|limit|restrict|reduce|maintain|monitor|check|keep|drink|eat|follow(?![\s-]?up)|rest|use|apply|wash|elevate|stay|walk|exercise|measure)\b/i;
const EVENT_KEYS = /\b(?:admit\w*|discharg\w*|collected|sample|reported|surgery|operation|procedure|scan|x-?ray|mri|vaccin\w*|appointment|follow[\s-]?up|review|visit|consult\w*|prescri\w*|issued|dated)\b/i;

export function detectKind(text, name = '') {
  const t = `${name}\n${String(text).slice(0, 1800)}`.toLowerCase();
  if (/discharge summary|discharge note|summary of (?:hospital )?stay/.test(t)) return 'discharge_summary';
  if (/laborator|lab report|pathology|specimen|reference range|sample collected|haematolog|hematolog|biochem/.test(t)) return 'lab_report';
  if (/prescription|\brx\b|\u211e|medication list/.test(t)) return 'prescription';
  if (/radiolog|x-?ray|\bmri\b|ct scan|ultrasound|sonograph|impression:/.test(t)) return 'imaging_report';
  if (/invoice|\bbill\b|insurance|claim no|policy no/.test(t)) return 'billing_or_insurance';
  if (/consultation|progress note|clinic note|\bopd\b|assessment|history of/.test(t)) return 'clinical_note';
  if (/\bdischarged\b/.test(t)) return 'discharge_summary';
  return 'other';
}

const KIND_LABEL = {
  prescription: 'Prescription issued',
  lab_report: 'Lab results reported',
  discharge_summary: 'Discharge summary issued',
  clinical_note: 'Clinic note written',
  imaging_report: 'Imaging report issued',
  billing_or_insurance: 'Billing document issued',
  other: 'Document dated',
};
export const kindLabel = (k) => KIND_LABEL[k] || KIND_LABEL.other;

/** Best guess at the date a document was issued (used to anchor "in 2 weeks"). */
export function guessDocDate(doc) {
  const text = doc.pages.map((p) => p.text).join('\n');
  const labels = [/\bdischarged\b\s*[:-]/i, /\bdate of discharge\b\s*[:-]?/i, /\bdischarge date\b\s*[:-]?/i, /\breported\b\s*[:-]/i, /\breport date\b\s*[:-]?/i, /\bissued\b\s*[:-]?/i, /\bdate\b\s*[:-]/i, /\bdated\b\s*[:-]?/i];
  for (const re of labels) {
    const m = re.exec(text);
    if (!m) continue;
    const d = findDates(text.slice(m.index + m[0].length, m.index + m[0].length + 32)).find((x) => x.iso);
    if (d) return { iso: d.iso, text: d.text };
  }
  const any = findDates(text).find((x) => x.iso);
  return any ? { iso: any.iso, text: any.text } : { iso: null, text: null };
}

function parseName(rest) {
  const paren = rest.match(/^([A-Za-z][\w'-]*)\s*\(([A-Za-z][^)]{1,30})\)/);
  if (paren) return `${paren[1]} (${paren[2]})`;
  const name = [];
  for (const t0 of rest.trim().split(/\s+/)) {
    const m = t0.match(/^([A-Za-z][A-Za-z0-9'-]*)([,;:.\u2014\u2013-]*)$/);
    const lower = m ? m[1].toLowerCase() : '';
    // "x" is a stop word ("Metformin x 5 days") unless it is the whole name ("medicine X")
    if (!m || (STOP_WORDS.has(lower) && !(lower === 'x' && name.length === 0)) || name.length >= 3) break;
    name.push(m[1]);
    if (m[2]) break;
  }
  return name.join(' ');
}

function actionOf(s) {
  const t = String(s);
  if (/\b(?:stop|stopped|discontinue[d]?|do not (?:take|continue)|withhold)\b/i.test(t)) return 'stop';
  if (/\bavoid\b/i.test(t)) return 'avoid';
  if (/\b(?:increase[d]?|decrease[d]?|reduce[d]?|changed? to|switch(?:ed)? to)\b/i.test(t)) return 'change';
  if (/\b(?:new|start|begin|commence)\b/i.test(t)) return 'start';
  if (/\b(?:continue|resume|same as before)\b/i.test(t)) return 'continue';
  if (parseFrequency(t).asNeeded) return 'as_needed';
  return 'mention';
}

function medFromUnit(unit) {
  const candidates = [];
  let m = unit.match(FORM_LINE);
  if (m) candidates.push(m[1]);
  m = unit.match(TAKE);
  if (m) candidates.push(`${m[1]} ${m[2]}`);
  m = unit.match(DOSE_LINE);
  if (m) {
    const tail = `${m[2]} ${m[3]}`;
    const f = parseFrequency(tail);
    if (f.perDay !== null || f.asNeeded) candidates.push(`${m[1]} ${tail}`);
  }
  for (const rest of candidates) {
    const name = parseName(rest);
    if (!name) continue;
    const dose = parseDose(rest);
    const freq = parseFrequency(rest);
    const dur = rest.match(/\b(?:for|x|\u00d7)\s*(\d+)\s*(days?|weeks?|months?)\b/i);
    return {
      name,
      dose: dose ? dose.text : null,
      frequency: freq.label,
      route: null,
      duration: dur ? `${dur[1]} ${dur[2].toLowerCase()}` : /\bcontinue\b/i.test(rest) ? 'ongoing' : null,
      action: actionOf(rest),
      quote: clip(unit, 220),
    };
  }
  return null;
}

const UNIT_RE = /^[A-Za-z\u00b5%/.*0-9]+(?:\/[A-Za-z0-9]+)?$/;
const FLAG_RE = /^(?:H|L|HH|LL|HIGH|LOW|CRITICAL|ABNORMAL|\*+|A)$/i;
const VALUE_RE = /^([<>]?\s*\d+(?:\.\d+)?)\s*([A-Za-z\u00b5%/.^0-9*]*)$/;

function resultFromLine(line) {
  const cols = line.trim().split(/\s{2,}|\t+|\s*\|\s*/).filter(Boolean);
  if (cols.length >= 3 && /^[A-Za-z]/.test(cols[0])) {
    const v = cols[1].match(VALUE_RE);
    if (v) {
      let unit = v[2] || null;
      let range = null;
      let flag = null;
      for (const c of cols.slice(2)) {
        if (!unit && UNIT_RE.test(c) && !/^\d/.test(c) && !FLAG_RE.test(c)) unit = c;
        else if (!range && parseRange(c)) range = c;
        else if (!flag && FLAG_RE.test(c)) flag = c.toUpperCase();
      }
      return { test: cols[0].trim(), value: v[1].replace(/\s/g, ''), unit, range, flag, quote: clip(line, 200) };
    }
  }
  const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ()/%.-]{1,40}?)\s+([<>]?\d+(?:\.\d+)?)\s*([A-Za-z\u00b5%]+(?:\/[A-Za-z]+)?)\s*[([]\s*((?:[<>\u2264\u2265]=?\s*)?\d+(?:\.\d+)?(?:\s*(?:-|\u2013|to)\s*\d+(?:\.\d+)?)?)\s*[)\]]\s*(H|L|HH|LL|HIGH|LOW|CRITICAL|ABNORMAL)?\s*$/i);
  return m ? { test: m[1].trim(), value: m[2], unit: m[3] || null, range: m[4], flag: m[5] ? m[5].toUpperCase() : null, quote: clip(line, 200) } : null;
}

function categoryOf(t) {
  if (/lab|test|sample|collected|result|scan|x-?ray|mri|report/i.test(t)) return 'test';
  if (/surgery|operation|procedure/i.test(t)) return 'procedure';
  if (/follow|review|repeat/i.test(t)) return 'followup';
  if (/prescri|tablet|dose|medic/i.test(t)) return 'medication';
  if (/admit|discharg|visit|consult|appointment|opd/i.test(t)) return 'visit';
  return 'other';
}

export function rulesExtract(docs) {
  const out = { documents: [], medications: [], instructions: [], events: [], followUps: [], results: [], issues: [], questions: [], summary: '' };

  for (const doc of docs) {
    const all = doc.pages.map((p) => p.text).join('\n');
    const kind = detectKind(all, doc.name);
    const dd = guessDocDate(doc);
    const provider = (doc.pages[0]?.text.match(/\bDr\.?[ \t]+[A-Z][A-Za-z.]*(?:[ \t]+[A-Z][A-Za-z.]*){0,2}/) || [null])[0];
    out.documents.push({ docId: doc.id, kind, date: dd.iso, provider: provider ? clip(provider, 60) : null, summary: `${upperFirst(kind.replace(/_/g, ' '))}, ${doc.pages.length} ${doc.unit}${doc.pages.length === 1 ? '' : 's'}.` });

    for (const pg of doc.pages) {
      const warnings = new Set(findWarningSigns([{ ...doc, pages: [pg] }], 20).map((w) => w.quote));
      for (const unit of textUnits(pg.text)) {
        const at = { docId: doc.id, page: pg.page };
        const lab = resultFromLine(unit);
        if (lab) {
          out.results.push({ ...at, ...lab });
          continue;
        }
        if (warnings.has(clip(unit, 240))) continue; // reported separately as a warning sign
        const med = medFromUnit(unit);
        if (med) {
          out.medications.push({ ...at, ...med });
          continue;
        }
        const when = findDates(unit).length > 0 || WHEN_RE.test(unit);
        if (FU_RE.test(unit) && when && !/\b(?:no|not)\s+(?:need|required|necessary)\b/i.test(unit)) {
          const rel = relativeFromText((unit.match(WHEN_RE) || [''])[0]);
          const dateInUnit = findDates(unit).find((d) => d.iso);
          out.followUps.push({
            ...at,
            quote: clip(unit, 220),
            action: clip(unit.replace(/^(?:[-*\u2022]|\d{1,2}[.)])\s*/, '').replace(/[\s.,;:-]+$/, ''), 140),
            timeframeText: rel ? rel.text : (unit.match(WHEN_RE) || [null])[0],
            dueDate: dateInUnit ? dateInUnit.iso : null,
            relative: rel && !dateInUnit ? { amount: rel.amount, unit: rel.unit } : null,
            whyEasyToMiss: '',
          });
          continue;
        }
        if (INSTR_RE.test(unit) && unit.length > 12 && unit.length < 260) {
          out.instructions.push({ ...at, quote: clip(unit, 220), text: clip(unit.replace(/^(?:[-*\u2022]|\d{1,2}[.)])\s*/, ''), 200) });
          continue;
        }
      }

      // dated events (split wide gaps so "Admitted: ...   Discharged: ..." becomes two events)
      for (const unit of textUnits(pg.text)) {
        for (const part of unit.split(/\s{3,}|\t|\|/)) {
          if (!EVENT_KEYS.test(part) || /\b(?:printed|generated|page \d)/i.test(part)) continue;
          const d = findDates(part)[0];
          if (!d) continue;
          let label = part.replace(d.text, ' ').replace(/\s+/g, ' ').replace(/^[\s:;,\-\u2013\u2014]+|[\s:;,\-\u2013\u2014]+$/g, '');
          label = label.replace(/^\d{1,2}[.)]\s*/, '');
          if (label.length < 4 || label.length > 90) label = KIND_LABEL[kind] || 'Dated item';
          out.events.push({ docId: doc.id, page: pg.page, quote: clip(part, 200), date: d.iso, dateText: d.text, label: upperFirst(clip(label, 80)), category: categoryOf(part) });
        }
      }
    }
  }
  return out;
}
