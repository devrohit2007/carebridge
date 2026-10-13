// Pure helper functions (no I/O). Shared by the rules engine, the AI post-processor and the tests.

// ---------- text ----------
export function cleanText(s, max = 200000) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .slice(0, max);
}

export const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}\u2026` : t;
};

/** Letters+digits only, lower-cased: lets us match a quote against a page ignoring spacing/punctuation/line breaks. */
export const matchKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function quoteInText(quote, text) {
  const q = matchKey(quote);
  return q.length >= 6 && matchKey(text).includes(q);
}

export const upperFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------- dates ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const pad = (n) => String(n).padStart(2, '0');
const monthNum = (s) => MONTHS[String(s).toLowerCase().slice(0, 3)];

export function validISO(y, m, d) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function isoOrNull(v) {
  const m = typeof v === 'string' ? v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  return m ? validISO(+m[1], +m[2], +m[3]) : null;
}

/** Find dates in free text. Day/month order that cannot be resolved is reported as ambiguous (iso = null). */
export function findDates(text) {
  const src = String(text ?? '');
  const found = [];
  const taken = [];
  const add = (m, iso, ambiguous = false) => {
    const s = m.index;
    const e = s + m[0].length;
    if (taken.some(([a, b]) => s < b && e > a)) return;
    taken.push([s, e]);
    found.push({ text: m[0], iso, ambiguous, index: s });
  };
  for (const m of src.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) add(m, validISO(+m[1], +m[2], +m[3]));
  for (const m of src.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.,]*(${MON})\\.?[\\s\\-/.,]*(\\d{4})\\b`, 'gi')))
    add(m, validISO(+m[3], monthNum(m[2]), +m[1]));
  for (const m of src.matchAll(new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi')))
    add(m, validISO(+m[3], monthNum(m[1]), +m[2]));
  for (const m of src.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/g)) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    if (a > 12 && b <= 12) add(m, validISO(y, b, a));
    else if (b > 12 && a <= 12) add(m, validISO(y, a, b));
    else if (a === b) add(m, validISO(y, a, b));
    else add(m, null, true);
  }
  return found.sort((x, y) => x.index - y.index);
}

export function normUnit(u) {
  const s = String(u ?? '').toLowerCase();
  if (s.startsWith('day')) return 'day';
  if (s.startsWith('week')) return 'week';
  if (s.startsWith('month')) return 'month';
  if (s.startsWith('year')) return 'year';
  return null;
}

export function addInterval(iso, amount, unit) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const u = normUnit(unit);
  if (u === 'day') dt.setUTCDate(dt.getUTCDate() + amount);
  else if (u === 'week') dt.setUTCDate(dt.getUTCDate() + 7 * amount);
  else if (u === 'month' || u === 'year') {
    const months = u === 'year' ? amount * 12 : amount;
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() + months);
    const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(d, last));
  } else return null;
  return dt.toISOString().slice(0, 10);
}

export const daysBetween = (aIso, bIso) => Math.round((Date.parse(`${bIso}T00:00:00Z`) - Date.parse(`${aIso}T00:00:00Z`)) / 86400000);

/** `today` comes from the browser (its local date) when valid and close to the server clock, else the server date. */
export function resolveToday(clientToday, now = new Date()) {
  const server = now.toISOString().slice(0, 10);
  const c = isoOrNull(clientToday);
  return c && Math.abs(daysBetween(server, c)) <= 2 ? c : server;
}

// ---------- medication frequency / dose ----------
export function parseFrequency(input) {
  const s = ` ${String(input ?? '').toLowerCase().replace(/(?<=[a-z])\.(?=[a-z])/g, '').replace(/[,;()]/g, ' ')} `;
  const asNeeded = /\b(prn|as needed|when needed|if needed|as required|when required|sos)\b/.test(s);
  let perDay = null;
  let label = null;
  const set = (v, m) => {
    if (perDay === null) {
      perDay = v;
      label = m[0].trim();
    }
  };
  let m;
  if ((m = s.match(/\bevery\s+other\s+day\b|\balternate\s+days?\b/))) set(0.5, m);
  else if ((m = s.match(/\b(?:twice|two times|2 times|2x)[\s-]*(?:a\s+|per\s+)?week(?:ly)?\b/))) set(2 / 7, m);
  else if ((m = s.match(/\b(?:three times|thrice|3 times|3x)[\s-]*(?:a\s+|per\s+)?week(?:ly)?\b/))) set(3 / 7, m);
  else if ((m = s.match(/\b(?:once|one time|1 time|1x)[\s-]*(?:a\s+|per\s+)?week(?:ly)?\b|\bweekly\b|\bevery week\b/))) set(1 / 7, m);
  else if ((m = s.match(/\bevery\s+(\d{1,2})\s*(?:hours?|hrs?|h)\b|\bq\s?(\d{1,2})\s?h\b/))) {
    const n = Number(m[1] || m[2]);
    if (n > 0 && n <= 24) set(24 / n, m);
  } else if ((m = s.match(/\b([0-3])\s?-\s?([0-3])\s?-\s?([0-3])(?:\s?-\s?([0-3]))?\b/)))
    set([m[1], m[2], m[3], m[4] || 0].reduce((a, b) => a + Number(b), 0), m);
  else if ((m = s.match(/\b(\d{1,2})\s*(?:x|times?)\s*(?:a|per|\/)?\s*(?:day|daily)\b/))) set(Number(m[1]), m);
  else if ((m = s.match(/\b(?:four times|qid|qds)\b/))) set(4, m);
  else if ((m = s.match(/\b(?:three times|thrice|tid|tds)\b/))) set(3, m);
  else if ((m = s.match(/\b(?:twice|two times|bid|bd)\b/))) set(2, m);
  else if ((m = s.match(/\b(?:once|one time|od|qd)\b/))) set(1, m);
  else if (
    (m = s.match(/\b(?:daily|every day|each day|every morning|every night|every evening|at bedtime|at night|nightly|nocte|mane|hs)\b|\bin the (?:morning|evening)\b/))
  )
    set(1, m);
  return { perDay, label, asNeeded };
}

export function parseDose(input) {
  const m = String(input ?? '').match(/(\d+(?:[.,]\d+)?)\s?(mg|mcg|\u00b5g|\u03bcg|ug|g|ml|iu|units?|%)(?![a-z])/i);
  if (!m) return null;
  let amount = parseFloat(m[1].replace(',', '.'));
  let unit = m[2].toLowerCase();
  if (unit === 'g') {
    amount *= 1000;
    unit = 'mg';
  } else if (['mcg', '\u00b5g', '\u03bcg', 'ug'].includes(unit)) {
    amount /= 1000;
    unit = 'mg';
  } else if (unit.startsWith('unit')) unit = 'units';
  return { amount, unit, text: m[0].trim() };
}

export const sameFrequency = (a, b) => Math.abs(a - b) < 0.01;
export const sameDose = (a, b) => a.unit === b.unit && Math.abs(a.amount - b.amount) <= 1e-6 * Math.max(1, a.amount, b.amount);

// ---------- drug names ----------
// Generic-name synonyms that are the same substance (INN vs USAN/BAN). Brand names are NOT mapped on purpose.
const SYNONYMS = {
  acetaminophen: 'paracetamol',
  albuterol: 'salbutamol',
  epinephrine: 'adrenaline',
  norepinephrine: 'noradrenaline',
  furosemide: 'frusemide',
  glyburide: 'glibenclamide',
  rifampin: 'rifampicin',
  lidocaine: 'lignocaine',
};

export function drugKey(name) {
  let s = String(name ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\b(tab(?:let)?s?|cap(?:sule)?s?|syp|syrup|susp(?:ension)?|inj(?:ection)?|oral|medicine|medication|drug|dose)\b\.?/g, ' ');
  s = s.replace(/\d+(?:[.,]\d+)?\s?(?:mg|mcg|\u00b5g|\u03bcg|ug|g|ml|iu|units?|%)(?![a-z])/g, ' ');
  s = s.replace(
    /\b(hydrochloride|hcl|sodium|potassium|calcium|sulfate|sulphate|maleate|besylate|mesylate|tartrate|succinate|fumarate|phosphate|acetate|citrate|bromide|er|xr|sr|cr|mr|ds|forte)\b/g,
    ' ',
  );
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return SYNONYMS[s] || s;
}

/** Keys a medication can be matched on: its own name plus any name written in brackets, e.g. "Glycomet (Metformin)". */
export function drugAliases(name) {
  const keys = new Set();
  const primary = drugKey(name);
  if (primary) keys.add(primary);
  for (const m of String(name ?? '').matchAll(/\(([^)]+)\)/g)) {
    const k = drugKey(m[1]);
    if (k && !/^\d/.test(k)) keys.add(k);
  }
  return [...keys];
}

// ---------- lab ranges ----------
export function parseRange(input) {
  const s = String(input ?? '').replace(/,(?=\d{3}\b)/g, '').trim();
  let m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|\u2013|\u2014|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (m && Number(m[1]) <= Number(m[2])) return { low: Number(m[1]), high: Number(m[2]) };
  m = s.match(/(<=|\u2264|<|up to|upto|less than|below|max(?:imum)?)\s*(\d+(?:\.\d+)?)/i);
  if (m) return { low: null, high: Number(m[2]), highExclusive: m[1] === '<' || /less than|below/i.test(m[1]) };
  m = s.match(/(>=|\u2265|>|more than|above|min(?:imum)?)\s*(\d+(?:\.\d+)?)/i);
  if (m) return { low: Number(m[2]), high: null };
  return null;
}

export function rangeStatus(value, range) {
  const v = parseFloat(String(value ?? '').replace(/[<>=\u2264\u2265\s,]/g, ''));
  if (!Number.isFinite(v) || !range) return null;
  if (range.low != null && v < range.low) return 'low';
  if (range.high != null && (range.highExclusive ? v >= range.high : v > range.high)) return 'high';
  return 'in';
}

// ---------- misc ----------
export function relativeFromText(text) {
  const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
  const m = String(text ?? '').match(
    /\b(?:in|after|within|every|about|around|at)?\s*(?:about\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)(?:\s*(?:-|\u2013|to)\s*(\d+))?\s*(day|week|month|year)s?\b/i,
  );
  if (!m) return null;
  const amount = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()];
  if (!amount || amount > 120) return null;
  return { amount, unit: normUnit(m[3]), text: m[0].trim() };
}
