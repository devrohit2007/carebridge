// Screens. Every function returns DOM nodes built with h(); nothing from a document is ever parsed as HTML.
import { daysFrom, fmtDate, h, icon, KIND_LABEL, ORIGIN_LABEL, pageLabel, plural, relDays } from './dom.js';

const strong = (t) => h('strong', null, t);
const bridgeSvg = () => {
  const s = h('span', { class: 'bridge', 'aria-hidden': 'true' });
  s.innerHTML = '<svg class="bridge__h" viewBox="0 0 52 34" focusable="false"><path d="M2 30c5-14 13-19 24-19s19 5 24 19"/><circle class="bridge__node" cx="26" cy="13" r="9"/><path d="M23.2 11.2a2.9 2.9 0 1 1 4 2.6c-.9.4-1.2 1-1.2 1.8"/><path d="M26 19.4h.01"/></svg><span class="bridge__v"><span class="bridge__vnode">?</span></span>';
  return s;
};

// ---------- shared pieces ----------
export function srcChip(s, actions) {
  return h('button', {
    type: 'button', class: `src${s.verified === false ? ' src--warn' : ''}`, onclick: () => actions.openSource(s),
    title: s.verified === false ? 'Quote could not be matched: verify manually' : 'Open this passage in the document', 'aria-label': `Open ${s.docName}, ${pageLabel(s)}`,
  }, h('span', { class: 'src__name' }, s.docName), h('span', { class: 'src__page' }, pageLabel(s)));
}
export function srcRow(sources, actions, max = 4) {
  const seen = new Set();
  const uniq = (sources || []).filter((s) => { const k = `${s.docId}:${s.page}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return h('div', { class: 'srcrow' }, uniq.slice(0, max).map((s) => srcChip(s, actions)));
}
const quoteBlock = (s, label = 'The document states') => h('blockquote', { class: 'quote' }, h('small', null, label), s.quote);

function compareView(items) {
  if (!items?.length) return null;
  const sides = items.slice(0, 4).map((c) => h('div', { class: 'cmp' },
    h('div', { class: 'cmp__doc' }, `${c.label}, ${pageLabel(c)}${c.dateText ? `, dated ${fmtDate(c.dateText)}` : ''}`),
    h('div', { class: 'cmp__value' }, c.value),
    h('div', { class: 'cmp__quote' }, `\u201c${c.quote}\u201d`)));
  if (sides.length > 2) return h('div', { class: 'compare compare--3' }, sides);
  return h('div', { class: 'compare' }, sides[0], bridgeSvg(), sides[1]);
}

const CAT = {
  verify: { cls: 'verify', icon: 'alert', pill: 'pill--verify', label: 'Needs verification' },
  followup: { cls: 'follow', icon: 'calendar', pill: 'pill--follow', label: 'Follow-up' },
  flagged: { cls: 'flag', icon: 'flask', pill: 'pill--flag', label: 'Flagged in report' },
  warning: { cls: 'flag', icon: 'alert', pill: 'pill--flag', label: 'Warning signs' },
};

function duePill(f, today) {
  if (f.status === 'overdue') return h('span', { class: 'pill pill--flag' }, 'Date may have passed');
  if (f.status === 'soon') return h('span', { class: 'pill pill--verify' }, 'Due soon');
  if (f.status === 'upcoming') return h('span', { class: 'pill pill--follow' }, 'Upcoming');
  return h('span', { class: 'pill' }, 'No date found');
}
function whenText(f, today) {
  if (f.dueDate) return `${f.dueEstimated ? 'About ' : ''}${fmtDate(f.dueDate)} (${relDays(daysFrom(today, f.dueDate))})`;
  return f.timeframeText || 'Timing not stated';
}

export function findingCard(f, actions, { quote = true } = {}) {
  const c = CAT[f.category] || CAT.verify;
  const more = h('details', { class: 'more' },
    h('summary', null, icon('chevron', 16), 'Why this was flagged'),
    h('dl', { class: 'kv' },
      h('div', null, h('dt', null, 'Why it was flagged'), h('dd', null, f.why)),
      f.nextStep ? h('div', null, h('dt', null, f.category === 'warning' ? 'If you are worried' : 'Safe next step'), h('dd', null, f.nextStep)) : null,
      f.question ? h('div', null, h('dt', null, 'A question you could ask'), h('dd', null, f.question)) : null,
      h('div', null, h('dt', null, 'How it was found'), h('dd', null, f.origin === 'ai' ? 'Suggested by the AI reader. CareBridge confirmed that the quoted text exists in your documents.' : 'Found by CareBridge\u2019s own checks on the text of your documents.'))));
  return h('article', { class: `card card--${c.cls}` },
    h('div', { class: 'row__top' }, icon(c.icon, 20), h('h3', { class: 'row__title' }, f.title)),
    h('div', { class: 'row__meta' }, h('span', { class: `pill ${c.pill}` }, c.label), f.priority === 'high' ? h('span', { class: 'pill' }, 'High priority') : null),
    compareView(f.compare),
    f.summary ? h('p', { class: 'row__sub' }, f.summary) : null,
    !f.compare?.length && quote && f.sources?.[0] ? quoteBlock(f.sources[0]) : null,
    h('div', { class: 'row__actions' }, srcRow(f.sources, actions), h('button', { type: 'button', class: 'btn btn--sm', onclick: () => actions.openSources(f) }, icon('eye', 16), 'View sources')),
    more);
}

const sectionHead = (title, count, tone, extra) => h('div', { class: 'sec__head' }, h('h2', null, title), count !== undefined ? h('span', { class: `count${tone ? ` count--${tone}` : ''}` }, count) : null, extra);
const safetyStrip = (compact) => h('aside', { class: 'safety', role: 'note' }, icon('shield', 20),
  h('div', null, h('p', null, strong('Information tool, not a doctor. '), 'CareBridge organizes what your documents say. It does not diagnose, prescribe or change any treatment.'),
    compact ? null : h('p', null, 'In an emergency, call your local emergency number or go to the nearest emergency department.')));
const fineprint = () => h('p', { class: 'fine' }, 'CareBridge reads the documents you add and points to the passages it relied on. It can misread photos and miss things, and it cannot know your full medical history. Always check the original documents and talk to your doctor or pharmacist before acting on anything here.');

// ---------- welcome ----------
export function welcome(state, actions) {
  const ai = state.health?.mode === 'ai';
  return h('div', null,
    h('section', { class: 'welcome' },
      h('div', { class: 'welcome__intro' },
        h('h1', null, 'Don\u2019t let an important instruction slip through.'),
        h('p', { class: 'lede' }, 'Add your prescriptions, lab reports and discharge papers. CareBridge cross-checks them, shows where they disagree, finds follow-ups that are easy to miss, and prepares a brief for your next visit.')),
      h('div', { class: 'welcome__drop' }, dropzone(actions, false)),
      h('ul', { class: 'trust welcome__trust' },
        h('li', null, icon('lock', 20), h('span', null, ai ? 'Files are read on your device. Only the extracted text is sent to the AI service for analysis. Nothing is stored on the server.' : 'Files are read on your device and analyzed by built-in rules. Nothing is stored on the server.')),
        h('li', null, icon('eye', 20), h('span', null, 'Every finding links to the page and quote it came from, so you can check it yourself.')),
        h('li', null, icon('shield', 20), h('span', null, 'No diagnoses, no dose advice, no \u201cstop your medicine\u201d. When documents disagree, it tells you to confirm with a professional.')))),
    fineprint());
}

export function dropzone(actions, compact) {
  const el = h('div', { class: `drop${compact ? ' drop--compact' : ''}`, dataset: { drop: '1' } },
    h('div', { class: 'drop__icon' }, icon('upload', compact ? 24 : 30)),
    h('div', null, h('h2', null, compact ? 'Add more documents' : 'Add your documents'), h('p', { class: 'muted small' }, 'PDF, photo or text file. Tap to choose, or drop files here.')),
    h('div', { class: 'drop__btns' },
      h('button', { type: 'button', class: 'btn btn--primary', onclick: actions.pickFiles }, icon('files', 18), 'Choose files'),
      h('button', { type: 'button', class: 'btn', onclick: actions.pickPhoto }, icon('camera', 18), 'Take a photo')),
    compact ? null : h('div', { class: 'or' }, 'or'),
    h('div', { class: 'drop__btns' },
      h('button', { type: 'button', class: 'btn btn--quiet', onclick: actions.pasteText }, icon('text', 18), 'Paste text'),
      compact ? null : h('button', { type: 'button', class: 'btn btn--quiet', onclick: actions.loadSamples }, icon('clipboard', 18), 'Try sample documents')));
  return el;
}

// ---------- processing ----------
const stepIcon = (st) => icon(st === 'done' ? 'check' : st === 'error' ? 'alert' : st === 'active' ? 'clock' : 'file', 18);
function stepEl(s) {
  const bar = h('div', { class: 'bar' }, h('i'));
  const el = h('div', { class: 'step', dataset: { state: s.status } }, stepIcon(s.status), h('span', { class: 'step__name' }, s.name), h('span', { class: 'small muted' }, s.detail || ''), bar);
  paintBar(el, s);
  return el;
}
function paintBar(el, s) {
  const bar = el.querySelector('.bar');
  bar.hidden = s.status !== 'active';
  bar.classList.toggle('bar--indeterminate', s.pct == null);
  bar.firstChild.style.width = s.pct == null ? '' : `${s.pct}%`;
}
/** Update progress in place so the animation above does not restart on every tick. */
export function patchSteps(steps) {
  const els = document.querySelectorAll('.steps .step');
  steps.forEach((s, i) => {
    const el = els[i];
    if (!el) return;
    if (el.dataset.state !== s.status) { el.dataset.state = s.status; el.firstChild.replaceWith(stepIcon(s.status)); }
    el.children[2].textContent = s.detail || '';
    paintBar(el, s);
  });
}

export function processing(state, actions) {
  const b = state.busy;
  const err = state.error;
  const arch = h('span', { class: 'bridge-anim', 'aria-hidden': 'true' });
  arch.innerHTML = '<svg viewBox="0 0 200 96" focusable="false"><path class="deck" d="M10 78h180"/><path class="arch" d="M24 78C24 40 58 22 100 22s76 18 76 56"/><rect class="pg" x="30" y="6" width="26" height="32" rx="4"/><rect class="pg" x="87" y="2" width="26" height="32" rx="4"/><rect class="pg" x="144" y="6" width="26" height="32" rx="4"/></svg>';
  return h('section', { class: 'proc' },
    err ? null : arch,
    h('h1', null, err ? 'That didn\u2019t work' : b?.title || 'Working\u2026'),
    err
      ? h('div', { class: 'errbox', role: 'alert' }, h('p', null, err), h('div', { class: 'drop__btns' }, state.docs.length ? h('button', { type: 'button', class: 'btn', onclick: actions.retry }, 'Try again') : null, h('button', { type: 'button', class: 'btn', onclick: actions.dismissError }, state.docs.length ? 'Back to my documents' : 'Back')))
      : h('p', { class: 'lede' }, b?.note || ''),
    err ? null : h('div', { class: 'steps', role: 'list' }, (b?.steps || []).map(stepEl)));
}

// ---------- overview ----------
export function overview(state, actions) {
  const a = state.analysis;
  const today = a.meta.today;
  const verify = a.findings.filter((f) => f.category === 'verify');
  const flagged = a.findings.filter((f) => f.category === 'flagged');
  const warnings = a.findings.filter((f) => f.category === 'warning');
  const nR = a.results.filter((r) => r.flagged).length;
  const ai = a.meta.mode === 'ai';

  const lede = h('p', { class: 'lede' }, strong(plural(a.documents.length, 'document')), ' analyzed. ',
    verify.length ? [strong(plural(verify.length, 'item')), verify.length === 1 ? ' needs verification' : ' need verification', '; '] : 'No conflicts between documents were found; ',
    strong(plural(a.followUps.length, 'follow-up')), a.followUps.length === 1 ? ' is' : ' are', ' mentioned and ', strong(plural(nR, 'result')), nR === 1 ? ' is' : ' are', ' flagged.');

  const verifyList = verify.length
    ? h('div', { class: 'list' }, verify.map((f) => h('article', { class: 'row row--verify' },
      h('div', { class: 'row__top' }, icon('alert', 20), h('h3', { class: 'row__title' }, f.title)),
      compareView(f.compare), h('p', { class: 'row__sub' }, f.summary),
      h('div', { class: 'row__actions' }, srcRow(f.sources, actions, 3), h('button', { type: 'button', class: 'btn btn--sm', onclick: () => actions.openSources(f) }, icon('eye', 16), 'View sources')))))
    : h('div', { class: 'list' }, h('p', { class: 'empty' }, icon('check', 22), 'No conflicting instructions found between your documents. Use \u201cWhat am I missing?\u201d for a deeper check.'));

  const followList = a.followUps.length
    ? h('div', { class: 'list' }, a.followUps.slice(0, 5).map((f) => h('article', { class: 'row row--follow' },
      h('div', { class: 'row__top' }, icon('calendar', 20), h('h3', { class: 'row__title' }, f.action)),
      h('div', { class: 'row__meta' }, duePill(f, today), h('span', { class: 'row__sub' }, whenText(f, today)), f.dueEstimated ? h('span', { class: 'small muted' }, 'estimated from the date on the document') : null),
      h('div', { class: 'row__actions' }, srcRow(f.sources, actions, 2)))))
    : h('div', { class: 'list' }, h('p', { class: 'empty' }, icon('info', 22), 'No follow-up instructions were found.'));

  const flagList = nR
    ? h('div', { class: 'list' }, a.results.filter((r) => r.flagged).slice(0, 6).map((r) => h('article', { class: 'row row--flag' },
      h('div', { class: 'row__top' }, icon('flask', 20), h('h3', { class: 'row__title' }, `${r.test}  ${r.value}${r.unit ? ` ${r.unit}` : ''}`)),
      h('div', { class: 'row__meta' }, h('span', { class: 'pill pill--flag' }, r.flagSource === 'document' ? `Report marks it ${r.flag}` : 'Outside printed range'), r.range ? h('span', { class: 'row__sub' }, `printed range ${r.range}`) : null),
      h('div', { class: 'row__actions' }, srcRow(r.sources, actions, 2)))))
    : null;

  const qs = a.questions.slice(0, 5);
  const qPanel = (cls) => h('div', { class: `panel ${cls}` }, h('h2', null, 'Things you may want to ask'),
    qs.length ? h('ol', { class: 'qlist' }, qs.map((q) => h('li', null, q.text))) : h('p', { class: 'muted small' }, 'No questions were generated.'),
    a.questions.length > qs.length ? h('button', { type: 'button', class: 'btn btn--sm btn--quiet', onclick: () => actions.go('questions') }, `See all ${a.questions.length} questions`) : null);
  const aside = h('aside', { class: 'aside' },
    qPanel('only-wide'),
    h('div', { class: 'panel' }, h('h2', null, 'Documents analyzed'),
      h('div', { class: 'minidocs' }, a.documents.map((d) => h('button', { type: 'button', class: 'minidoc', onclick: () => actions.viewDoc(d.id, 1) }, icon('file', 18), h('span', null, d.name), h('span', { class: 'muted small' }, plural(d.pages, d.unit)))))));

  return h('div', null,
    safetyStrip(false),
    h('header', { class: 'head' },
      h('h1', null, 'Care overview'), lede,
      h('div', { class: 'head__meta' },
        h('span', { class: `pill ${ai ? 'pill--ok' : ''}` }, ai ? 'AI-assisted, sources verified' : 'Rules-based analysis'),
        ai ? h('span', { class: 'pill' }, a.meta.model) : h('span', { class: 'pill' }, 'No AI model used'),
        h('span', { class: 'pill' }, `${a.meta.pageCount} ${a.meta.pageCount === 1 ? 'page' : 'pages'} read`)),
      a.meta.notice ? h('div', { class: 'notice', role: 'status' }, icon('info', 20), h('p', null, a.meta.notice)) : null,
      a.meta.dropped.unverified || a.meta.dropped.unsafe ? h('p', { class: 'small muted' }, `${a.meta.dropped.unverified + a.meta.dropped.unsafe} AI suggestion${a.meta.dropped.unverified + a.meta.dropped.unsafe === 1 ? ' was' : 's were'} hidden because a quote could not be found in your documents or the wording broke CareBridge\u2019s safety rules.`) : null,
      h('div', { class: 'cta' },
        h('button', { type: 'button', class: 'btn btn--primary', onclick: actions.runMissing }, icon('search', 20), 'What am I missing?'),
        h('button', { type: 'button', class: 'btn', onclick: actions.showBrief }, icon('clipboard', 20), 'Generate Doctor Visit Brief'))),
    h('div', { class: 'cols' },
      h('div', null,
        h('section', { class: 'sec' }, sectionHead('Needs verification', verify.length, verify.length ? 'verify' : null, verify.length ? h('button', { type: 'button', class: 'btn btn--sm btn--quiet', onclick: () => actions.go('findings') }, 'All findings') : null), verifyList),
        h('section', { class: 'sec' }, sectionHead('Follow-ups', a.followUps.length), followList),
        h('section', { class: 'sec only-narrow' }, qPanel('')),
        flagList ? h('section', { class: 'sec' }, sectionHead('Flagged in your reports', nR), flagList, h('p', { class: 'small muted' }, 'CareBridge repeats what the report prints. It does not say what a result means.')) : null,
        warnings.length ? h('section', { class: 'sec' }, sectionHead('Warning signs your documents mention'), h('div', { class: 'cards' }, warnings.map((f) => findingCard(f, actions)))) : null),
      aside),
    fineprint());
}

// ---------- findings ----------
export function findings(state, actions) {
  const a = state.analysis;
  const filter = state.filter;
  const groups = [
    ['all', 'All', a.findings.length], ['verify', 'Needs verification', a.findings.filter((f) => f.category === 'verify').length],
    ['followup', 'Follow-ups', a.findings.filter((f) => f.category === 'followup').length], ['flagged', 'Flagged results', a.findings.filter((f) => f.category === 'flagged').length],
    ['warning', 'Warning signs', a.findings.filter((f) => f.category === 'warning').length], ['instructions', 'Instructions', a.instructions.length],
  ].filter(([k, , n]) => k === 'all' || n > 0);
  const shown = filter === 'instructions' ? [] : a.findings.filter((f) => filter === 'all' || f.category === filter);
  return h('div', null,
    h('h1', null, 'Findings'),
    h('p', { class: 'lede' }, 'Everything CareBridge noticed, with the passage it came from. Open any item to see why it was flagged and a safe next step.'),
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter findings' }, groups.map(([k, label, n]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === k), onclick: () => actions.setFilter(k) }, label, h('span', { class: 'count' }, n)))),
    filter === 'instructions'
      ? h('div', { class: 'list' }, a.instructions.map((i) => h('article', { class: 'row' }, h('p', { class: 'row__title' }, i.text), h('div', { class: 'row__actions' }, srcRow(i.sources, actions, 2)))))
      : h('div', { class: 'cards cards--2' }, shown.map((f) => findingCard(f, actions))),
    fineprint());
}

// ---------- questions ----------
export function questions(state, actions) {
  const a = state.analysis;
  return h('div', null,
    h('h1', null, 'Questions for your doctor'),
    h('p', { class: 'lede' }, 'Suggestions for the conversation, written from what your documents say. They are not medical advice, and they are ordered by what CareBridge thinks is most worth confirming.'),
    h('div', { class: 'toolbar' },
      h('button', { type: 'button', class: 'btn', onclick: () => actions.copy(a.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n'), 'Questions copied') }, icon('copy', 18), 'Copy all questions'),
      h('button', { type: 'button', class: 'btn', onclick: actions.showBrief }, icon('clipboard', 18), 'Doctor Visit Brief')),
    h('div', { class: 'panel' }, a.questions.length ? h('ol', { class: 'qlist' }, a.questions.map((q) => {
      const f = a.findings.find((x) => x.id === q.findingId);
      return h('li', null, h('div', null, h('p', null, q.text), f ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => actions.openSources(f) }, `About: ${f.title}`) : null));
    })) : h('p', { class: 'muted' }, 'No questions were generated for these documents.')),
    fineprint());
}

// ---------- timeline ----------
export function timeline(state, actions) {
  const a = state.analysis;
  const today = a.meta.today;
  const dated = a.timeline.filter((e) => e.date);
  const past = dated.filter((e) => e.date < today);
  const upcoming = dated.filter((e) => e.date >= today);
  const undated = a.timeline.filter((e) => !e.date);
  const item = (e) => {
    const d = daysFrom(today, e.date);
    return h('li', { class: `tl__item${e.date > today ? ' tl__item--future' : ''}`, dataset: { cat: e.category } },
      h('span', { class: 'tl__dot' }),
      h('div', { class: 'tl__date' }, fmtDate(e.date), h('span', { class: 'muted' }, relDays(d)),
        e.estimated ? h('span', { class: 'pill' }, 'Estimated') : null, e.status === 'soon' ? h('span', { class: 'pill pill--verify' }, 'Due soon') : null, e.status === 'overdue' ? h('span', { class: 'pill pill--flag' }, 'Date may have passed') : null),
      h('p', { class: 'tl__label' }, e.label), srcRow(e.sources, actions, 2));
  };
  return h('div', null,
    h('h1', null, 'Timeline'),
    h('p', { class: 'lede' }, 'Dates found in your documents, in order. Dashed markers are future dates; \u201cestimated\u201d means CareBridge added a time span such as \u201cin 2 weeks\u201d to the date on the document.'),
    a.timeline.length
      ? h('ol', { class: 'tl' }, past.map(item), h('li', { class: 'tl__today' }, `Today, ${fmtDate(today)}`), upcoming.map(item))
      : h('div', { class: 'panel' }, h('p', { class: 'muted' }, 'No dates could be read from these documents.')),
    undated.length ? h('div', null, h('p', { class: 'tl__group' }, 'Date not stated'), h('ol', { class: 'tl' }, undated.map((e) => h('li', { class: 'tl__item', dataset: { cat: e.category } }, h('span', { class: 'tl__dot' }), h('p', { class: 'tl__label' }, e.label), srcRow(e.sources, actions, 2))))) : null,
    fineprint());
}

// ---------- brief ----------
export function brief(state, actions) {
  const a = state.analysis;
  const b = a.brief;
  const sec = (title, body) => h('section', null, h('h2', null, title), body);
  const src = (t) => h('span', { class: 'meta' }, ` (${t})`);
  return h('div', null,
    h('div', { class: 'no-print' }, safetyStrip(true)),
    h('div', { class: 'toolbar no-print' },
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => window.print() }, icon('printer', 18), 'Print or save as PDF'),
      h('button', { type: 'button', class: 'btn', onclick: () => actions.copy(a.briefText, 'Brief copied') }, icon('copy', 18), 'Copy as text'),
      navigator.share ? h('button', { type: 'button', class: 'btn', onclick: () => actions.share(a.briefText) }, icon('share', 18), 'Share') : null),
    h('article', { class: 'paper' },
      h('header', null, h('h1', null, 'Doctor Visit Brief'), h('p', { class: 'meta' }, `Prepared ${fmtDate(b.preparedOn)} with CareBridge from ${plural(b.documents.length, 'document')} supplied by the patient.`), h('p', { class: 'small muted' }, b.disclaimer)),
      sec('Documents reviewed', h('ul', null, b.documents.map((d) => h('li', null, strong(d.name), h('div', { class: 'statement' }, `${KIND_LABEL[d.kind] || 'Document'}${d.date ? `, dated ${fmtDate(d.date)}` : ''}, ${plural(d.pages, d.unit)}`))))),
      b.needsVerification.length ? sec('Needs verification', h('ul', null, b.needsVerification.map((n) => h('li', null, strong(n.title), n.statements.map((s) => h('div', { class: 'statement' }, `${s.label}, ${s.unit === 'section' ? 'section' : 'p.'} ${s.page}: ${s.value}`)))))) : null,
      b.medications.length ? sec('Medications as written in the documents', h('ul', null, b.medications.map((m) => h('li', null, strong(m.name), m.conflict ? h('span', { class: 'flagtag' }, '  documents differ, please verify') : null, m.entries.map((e) => h('div', { class: 'statement' }, e.value, src(e.source))))))) : null,
      b.followUps.length ? sec('Follow-ups mentioned', h('ul', null, b.followUps.map((f) => h('li', null, strong(f.action), ` \u2013 ${f.when}`, src(f.source))))) : null,
      b.flaggedResults.length ? sec('Results flagged or outside the printed range', h('ul', null, b.flaggedResults.map((r) => h('li', null, strong(r.test), ` ${r.value}`, r.range ? ` (printed range ${r.range})` : '', src(r.source))))) : null,
      b.warningSigns.length ? sec('Warning signs the documents mention', h('div', null, h('ul', null, b.warningSigns.map((w) => h('li', null, w.text, src(w.source)))), h('p', { class: 'small' }, strong(b.emergency)))) : null,
      b.questions.length ? sec('Questions to ask', h('ol', null, b.questions.map((q) => h('li', null, q)))) : null,
      h('p', { class: 'small muted' }, 'Every item comes from the patient\u2019s own documents and should be checked against the originals.')));
}

// ---------- documents ----------
function highlighted(text, quote) {
  const tokens = String(quote || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return [text];
  let m = null;
  try { m = new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+'), 'iu').exec(text); } catch { m = null; }
  if (!m) return [text];
  return [text.slice(0, m.index), h('mark', { id: 'hit' }, m[0]), text.slice(m.index + m[0].length)];
}

export function documents(state, actions) {
  const a = state.analysis;
  const meta = (id) => a?.documents.find((d) => d.id === id);
  const v = state.viewer;
  const doc = v && state.docs.find((d) => d.id === v.docId);
  let viewer = null;
  if (doc) {
    const pg = doc.pages.find((p) => p.page === v.page) || doc.pages[0];
    const idx = doc.pages.indexOf(pg);
    const go = (i) => actions.viewDoc(doc.id, doc.pages[i].page);
    viewer = h('section', { class: 'viewer', 'aria-label': 'Document text' },
      h('div', { class: 'viewer__bar' }, strong(doc.name), h('span', { class: 'small muted' }, `${doc.unit === 'section' ? 'Section' : 'Page'} ${pg.page} of ${doc.pages.length}`),
        h('button', { type: 'button', class: 'btn btn--sm', disabled: idx <= 0, onclick: () => go(idx - 1), 'aria-label': 'Previous page' }, icon('left', 16)),
        h('button', { type: 'button', class: 'btn btn--sm', disabled: idx >= doc.pages.length - 1, onclick: () => go(idx + 1), 'aria-label': 'Next page' }, icon('chevron', 16)),
        h('button', { type: 'button', class: 'btn btn--sm btn--quiet', onclick: () => actions.viewDoc(null) }, icon('x', 16), 'Close')),
      h('div', { class: 'viewer__body' },
        doc.warnings?.map((w) => h('div', { class: 'notice' }, icon('info', 20), h('p', null, w))),
        doc.previewUrl ? h('img', { class: 'viewer__img', src: doc.previewUrl, alt: `Original photo of ${doc.name}` }) : null,
        v.quote ? h('p', { class: 'small muted' }, 'The highlighted passage is the one CareBridge relied on.') : null,
        h('pre', { class: 'doc-text', tabindex: '0' }, highlighted(pg.text, v.quote))));
  }
  return h('div', null,
    h('h1', null, 'Documents'),
    h('p', { class: 'lede' }, 'The text CareBridge extracted from each file. If something looks wrong here, the findings built on it may be wrong too.'),
    h('div', { class: 'docs' }, state.docs.map((d) => {
      const m = meta(d.id);
      return h('article', { class: 'doc', 'aria-current': String(doc?.id === d.id) },
        h('div', { class: 'doc__top' }, h('div', { class: 'doc__icon' }, icon(d.origin === 'ocr' || d.origin === 'image-ai' ? 'image' : 'file', 22)),
          h('div', null, h('p', { class: 'doc__name' }, d.name),
            h('div', { class: 'doc__meta' }, m ? h('span', { class: 'pill' }, KIND_LABEL[m.kind] || 'Document') : null, m?.date ? h('span', { class: 'pill' }, `Dated ${fmtDate(m.date)}`) : null,
              h('span', { class: 'pill' }, plural(d.pages.length, d.unit)), h('span', { class: 'pill' }, ORIGIN_LABEL[d.origin] || d.origin), d.ocrConfidence != null ? h('span', { class: 'pill pill--verify' }, `${d.ocrConfidence}% OCR confidence`) : null))),
        h('div', { class: 'doc__btns' }, h('button', { type: 'button', class: 'btn btn--sm', onclick: () => actions.viewDoc(d.id, 1) }, icon('eye', 16), 'View text'),
          h('button', { type: 'button', class: 'btn btn--sm btn--quiet btn--danger', onclick: () => actions.removeDoc(d.id) }, icon('trash', 16), 'Remove')));
    })),
    !a ? h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn btn--primary', onclick: actions.analyze }, icon('search', 18), 'Analyze these documents')) : null,
    viewer,
    h('div', { class: 'sec' }, dropzone(actions, true)),
    h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn btn--quiet btn--danger', onclick: actions.clearAll }, icon('trash', 18), 'Clear everything from this device')),
    fineprint());
}

// ---------- sheets ----------
export function sourcesSheet(f, actions) {
  return {
    title: 'Sources', subtitle: f.title,
    body: [
      ...f.sources.map((s) => h('article', { class: 'card card--ok' },
        h('div', { class: 'row__top' }, icon('file', 20), h('h3', { class: 'row__title' }, `${s.docName}, ${pageLabel(s)}`),
          s.verified ? h('span', { class: 'pill pill--ok' }, 'Found in the document') : h('span', { class: 'pill pill--flag' }, 'Not matched: verify manually')),
        quoteBlock(s), h('div', { class: 'row__actions' }, h('button', { type: 'button', class: 'btn btn--sm', onclick: () => actions.openSource(s) }, icon('eye', 16), 'Open in document')))),
      h('p', { class: 'small muted' }, 'CareBridge shows the exact text it relied on. If a photo or scan was misread, the original document is the authority.'),
    ],
  };
}

const CHECK_TONE = { meds: 'verify', followups: 'follow', dates: 'follow', results: 'flag', warnings: 'flag', quality: 'verify', ai: 'verify' };
export function missingSheet(state, actions) {
  const m = state.missing;
  const a = state.analysis;
  if (state.missingBusy) {
    return {
      title: 'What am I missing?', subtitle: 'Re-reading everything together\u2026',
      body: [h('p', { class: 'lede' }, `Looking across ${plural(a.documents.length, 'document')} and ${plural(a.meta.pageCount, 'page')} for conflicts, buried instructions, results nobody mentions and dates that may have slipped.`),
        h('div', { class: 'checks' }, [0, 1, 2, 3].map(() => h('div', { class: 'check' }, h('span', null), h('div', null, h('div', { class: 'skeleton' })), h('span', null)))),
        h('div', { class: 'bar bar--indeterminate' }, h('i'))],
    };
  }
  if (state.missingError) {
    return { title: 'What am I missing?', subtitle: '', body: [h('div', { class: 'errbox', role: 'alert' }, h('p', null, state.missingError), h('button', { type: 'button', class: 'btn', onclick: actions.runMissing }, 'Try again'))] };
  }
  const cards = m.items.map((it) => {
    const tone = CHECK_TONE[it.check] || 'verify';
    return findingCard({
      id: it.id, category: tone === 'follow' ? 'followup' : tone === 'flag' ? (it.kind === 'warning_signs' ? 'warning' : 'flagged') : 'verify',
      title: it.title, summary: it.summary, why: it.why, nextStep: it.nextStep, question: it.question, sources: it.sources, origin: it.origin,
    }, actions, { quote: true });
  });
  return {
    title: 'What am I missing?', subtitle: `Checked ${plural(m.documentCount, 'document')} (${plural(m.pageCount, 'page')}) together`,
    body: [
      m.notice ? h('div', { class: 'notice' }, icon('info', 20), h('p', null, m.notice)) : null,
      h('div', null, h('h2', null, 'How CareBridge looked'), h('div', { class: 'checks' }, m.checks.map((c) => h('div', { class: 'check', dataset: { status: c.status } },
        icon(c.status === 'clear' ? 'check' : c.status === 'review' ? 'alert' : 'info', 20), h('div', null, c.label, h('small', null, c.detail)),
        h('span', { class: `count${c.status === 'review' ? ' count--verify' : ''}` }, c.status === 'skipped' ? 'skipped' : c.count || 'clear'))))),
      h('div', null, h('h2', null, cards.length ? `Worth double-checking (${cards.length})` : 'Nothing else stood out'),
        cards.length ? h('div', { class: 'cards' }, cards) : h('p', { class: 'muted' }, 'That does not prove nothing is missing: CareBridge can only see what is in the documents you added. If something feels off, ask your clinic.')),
      h('p', { class: 'small muted' }, 'These are prompts to double-check, not conclusions. Nothing here is a diagnosis or a change to your treatment.'),
    ],
  };
}
