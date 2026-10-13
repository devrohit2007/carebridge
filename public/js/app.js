// CareBridge front-end controller. No framework, no build step: ES modules served as-is.
import * as api from './api.js';
import { append, clear, copyText, h, icon, plural, todayISO, toast } from './dom.js';
import { extractFile, makeTextDoc, stopOcr } from './extract.js';
import * as V from './views.js';

const $ = (s) => document.querySelector(s);
const ROUTES = [
  ['overview', 'Overview', 'overview'], ['timeline', 'Timeline', 'timeline'], ['findings', 'Findings', 'flag'],
  ['questions', 'Questions', 'help'], ['brief', 'Brief', 'clipboard'], ['documents', 'Documents', 'files'],
];
const KEY = 'carebridge.session';
const PROVIDER = { gemini: 'Google Gemini', openai: 'an OpenAI-compatible AI service', anthropic: 'Anthropic Claude' };

const state = {
  health: null, docs: [], analysis: null, missing: null, missingBusy: false, missingError: null,
  busy: null, error: null, route: 'overview', filter: 'all', viewer: null, nextDoc: 1, lastAction: null,
};

// ---------- persistence (this tab only; cleared when the tab closes) ----------
function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({
      docs: state.docs.map(({ previewUrl, size, ...d }) => d), analysis: state.analysis, missing: state.missing, nextDoc: state.nextDoc,
    }));
  } catch { /* quota or blocked: the session simply will not survive a reload */ }
}
function restore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (s?.docs?.length) Object.assign(state, { docs: s.docs, analysis: s.analysis || null, missing: s.missing || null, nextDoc: s.nextDoc || s.docs.length + 1 });
  } catch { /* ignore corrupt data */ }
}
function wipe() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  state.docs.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl));
  Object.assign(state, { docs: [], analysis: null, missing: null, missingError: null, viewer: null, busy: null, error: null, filter: 'all', nextDoc: 1 });
}

// ---------- dialogs ----------
const sheet = () => $('#sheet');
let sheetKind = null;
function fillSheet({ title, subtitle, body }) {
  const dlg = sheet();
  clear(dlg);
  dlg.append(
    h('div', { class: 'sheet__head' }, h('div', null, h('h2', null, title), subtitle ? h('p', null, subtitle) : null),
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', onclick: closeSheet }, icon('x', 20))),
    append(h('div', { class: 'sheet__body' }), [body]));
}
function openSheet(content, kind = 'generic') {
  const dlg = sheet();
  sheetKind = kind;
  fillSheet(content);
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.sheet__body').scrollTop = 0;
}
function closeSheet() { const d = sheet(); if (d.open) d.close(); }
function ask({ title, body, confirm = 'Continue', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; sheet().removeEventListener('close', onClose); closeSheet(); resolve(v); };
    const onClose = () => finish(false);
    openSheet({
      title, body: [h('div', { class: 'stack' }, body.map((t) => h('p', { class: 'lede' }, t))),
        h('div', { class: 'drop__btns' }, h('button', { type: 'button', class: 'btn', onclick: () => finish(false) }, cancel),
          h('button', { type: 'button', class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, onclick: () => finish(true) }, confirm))],
    }, 'ask');
    sheet().addEventListener('close', onClose, { once: true });
  });
}
async function ensureConsent() {
  if (state.health?.mode !== 'ai') return true;
  try { if (localStorage.getItem('carebridge.consent') === '1') return true; } catch { /* ignore */ }
  const ok = await ask({
    title: 'Before you add real documents',
    body: [`To analyze them, CareBridge sends the text of your documents (and any photos you add) to ${PROVIDER[state.health.provider] || 'the configured AI service'}. CareBridge itself stores nothing on the server.`,
      'That service has its own data policy; some free tiers may use submitted content to improve their products. Only add documents you are comfortable sharing, or try the sample documents first.'],
    confirm: 'I understand, continue',
  });
  if (ok) try { localStorage.setItem('carebridge.consent', '1'); } catch { /* ignore */ }
  return ok;
}
function askAccessCode(wrong) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', autocomplete: 'off', class: 'field', 'aria-label': 'Access code', placeholder: 'Access code' });
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeSheet(); resolve(v); };
    openSheet({
      title: 'Access code needed', subtitle: wrong ? 'That code was not correct.' : 'This CareBridge demo is protected.',
      body: [input, h('div', { class: 'drop__btns' }, h('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, 'Cancel'), h('button', { type: 'button', class: 'btn btn--primary', onclick: () => finish(input.value.trim()) }, 'Continue'))],
    }, 'ask');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    sheet().addEventListener('close', () => finish(null), { once: true });
    setTimeout(() => input.focus(), 50);
  });
}
async function withAccess(fn) {
  for (let i = 0; i < 4; i++) {
    try { return await fn(); } catch (e) {
      if (e.status !== 401 || !state.health?.accessCodeRequired) throw e;
      const code = await askAccessCode(i > 0);
      if (!code) throw new Error('An access code is needed to analyze documents.');
      api.setAccessCode(code);
    }
  }
  throw new Error('The access code was not accepted.');
}

// ---------- shell ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0A1317' : '#F3F6F7');
  try { localStorage.setItem('carebridge.theme', t); } catch { /* ignore */ }
}
const theme = () => document.documentElement.getAttribute('data-theme');
function toggleTheme() { applyTheme(theme() === 'dark' ? 'light' : 'dark'); renderChrome(); }

function brand() {
  const mark = h('span', { class: 'brand__mark' }, icon('logo', 20));
  return h('a', { class: 'brand', href: '#/overview', 'aria-label': 'CareBridge home' }, mark, 'CareBridge');
}
function renderChrome() {
  const app = $('#app');
  const has = state.docs.length > 0;
  app.className = `app shell${has ? '' : ' shell--bare'}`;
  clear(app);
  const f = state.analysis?.findings || [];
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    h('div', { class: 'nav__brand' }, brand()),
    h('div', { class: 'nav__list' }, ROUTES.map(([id, label, ic]) => {
      const c = id === 'findings' && f.length ? f.length : id === 'questions' && state.analysis?.questions.length ? state.analysis.questions.length : id === 'documents' ? state.docs.length : 0;
      return h('a', { class: 'nav__item', href: `#/${id}`, 'aria-current': state.route === id ? 'page' : null, ...(id === 'documents' ? { 'data-desktop-only': '' } : {}) },
        icon(ic, 22), h('span', null, label), c ? h('span', { class: 'count' }, c) : null);
    })),
    h('div', { class: 'nav__foot' },
      h('span', null, state.health?.mode === 'ai' ? `AI: ${PROVIDER[state.health.provider]?.replace('an ', '') || state.health.provider}` : 'Rules-only mode (no AI model)'),
      h('button', { type: 'button', class: 'btn btn--sm btn--quiet', onclick: toggleTheme }, icon(theme() === 'dark' ? 'sun' : 'moon', 16), theme() === 'dark' ? 'Light mode' : 'Dark mode')));
  const top = h('header', { class: 'topbar' }, brand(), h('span', { class: 'topbar__spacer' }),
    has ? h('a', { class: 'iconbtn', href: '#/documents', 'aria-label': `Documents (${state.docs.length})` }, icon('files', 22), h('span', { class: 'badge' }, state.docs.length)) : null,
    h('button', { type: 'button', class: 'iconbtn', 'aria-label': theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', onclick: toggleTheme }, icon(theme() === 'dark' ? 'sun' : 'moon', 22)));
  const main = h('main', { class: 'main', id: 'view', tabindex: '-1' });
  app.append(top, nav, main);
  return main;
}

function render() {
  const main = renderChrome();
  let view;
  if (state.busy || state.error) view = V.processing(state, actions);
  else if (!state.docs.length) view = V.welcome(state, actions);
  else if (!state.analysis) view = V.documents(state, actions);
  else view = ({ overview: V.overview, timeline: V.timeline, findings: V.findings, questions: V.questions, brief: V.brief, documents: V.documents }[state.route] || V.overview)(state, actions);
  if (state.upgrading && state.analysis && !state.busy) main.append(h('div', { class: 'upgrading', role: 'status' }, icon('clock', 18), h('span', null, 'These are CareBridge\u2019s built-in results. The AI is reading your documents now and will update them automatically.')));
  main.append(view);
  document.title = state.analysis && !state.busy ? `${ROUTES.find((r) => r[0] === state.route)?.[1] || 'CareBridge'} - CareBridge` : 'CareBridge - cross-check your care documents';
}

function go(route) {
  if (!ROUTES.some((r) => r[0] === route)) route = 'overview';
  if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
  else onHash();
}
function onHash() {
  const r = location.hash.replace(/^#\/?/, '');
  state.route = ROUTES.some((x) => x[0] === r) ? r : 'overview';
  if (state.route !== 'documents') state.viewer = null;
  render();
  if (!state.viewer) window.scrollTo(0, 0);
}

// ---------- pipeline ----------
const slim = (a) => ({ documents: a.documents, medications: a.medications, followUps: a.followUps, results: a.results, instructions: a.instructions, warningSigns: a.warningSigns, findings: a.findings.map((f) => ({ title: f.title, kind: f.kind, category: f.category })) });
const serverDocs = () => api.forServer(state.docs);

async function runAnalysis(steps) {
  state.lastAction = () => runAnalysis();
  const mine = steps || [{ name: 'Cross-checking your documents', status: 'queued', detail: '', pct: null }];
  const last = mine[mine.length - 1];
  const ai = state.health?.mode === 'ai';
  state.busy = { title: steps ? 'Reading your documents' : 'Cross-checking your documents', note: ai ? `CareBridge is comparing ${plural(state.docs.length, 'document')} and checking every quote against the original text. This usually takes 10 to 40 seconds.` : `CareBridge is comparing ${plural(state.docs.length, 'document')} using its built-in rules.`, steps: mine };
  state.error = null;
  state.missing = null;
  last.status = 'active'; last.pct = null; last.detail = ai ? 'Waiting for the AI reader' : '';
  render();
  const run = (state.runId = (state.runId || 0) + 1);
  const docsKey = state.docs.map((d) => d.id).join(',');
  try {
    // With AI configured: show the instant built-in results first, then upgrade them when the AI finishes (much faster to first result).
    const progressive = state.health?.mode === 'ai';
    state.analysis = await withAccess(() => api.analyze(serverDocs(), todayISO(), undefined, progressive ? 'off' : undefined));
    last.status = 'done';
    state.busy = null;
    state.route = 'overview';
    if (location.hash !== '#/overview') location.hash = '#/overview';
    save();
    if (progressive) state.upgrading = true;
    render();
    window.scrollTo(0, 0);
    if (progressive) {
      try {
        const full = await withAccess(() => api.analyze(serverDocs(), todayISO()));
        if (state.runId === run && state.docs.map((d) => d.id).join(',') === docsKey) {
          state.analysis = full; state.missing = null; save();
          toast(full.meta.mode === 'ai' ? 'AI reading added to your results.' : 'The AI could not finish, so the built-in results are kept.', 'info');
        }
      } catch (err) {
        if (state.runId === run) toast(`${err.message} The built-in results are kept.`, 'error');
      }
      if (state.runId === run) { state.upgrading = false; render(); }
    }
  } catch (e) {
    state.upgrading = false;
    last.status = 'error';
    state.busy = null;
    state.analysis = null;
    state.error = e.message || 'Something went wrong.';
    render();
  }
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length || state.busy) return;
  const max = state.health.limits.maxDocs;
  if (state.docs.length + files.length > max) {
    toast(`CareBridge can analyze up to ${max} documents at a time.`, 'error');
    files.length = Math.max(0, max - state.docs.length);
    if (!files.length) return;
  }
  if (!(await ensureConsent())) return;
  state.lastAction = () => addFiles(files);
  const steps = [...files.map((f) => ({ name: f.name, status: 'queued', detail: '', pct: null })), { name: 'Cross-checking your documents', status: 'queued', detail: '', pct: null }];
  state.busy = { title: 'Reading your documents', note: 'Files are read on this device. Only the extracted text is sent for analysis.', steps };
  state.error = null;
  render();
  const added = [];
  const problems = [];
  for (let i = 0; i < files.length; i++) {
    const st = steps[i];
    st.status = 'active'; st.detail = 'Starting'; V.patchSteps(steps);
    try {
      const doc = await extractFile(files[i], { id: `d${state.nextDoc}`, health: state.health, onStatus: (t, p) => { st.detail = t; st.pct = p; V.patchSteps(steps); } });
      state.nextDoc += 1;
      st.status = 'done'; st.pct = null; st.detail = plural(doc.pages.length, doc.unit);
      added.push(doc);
    } catch (e) {
      st.status = 'error'; st.pct = null; st.detail = 'Could not read';
      problems.push(e.message || `"${files[i].name}" could not be read.`);
      if (e.status === 401 || e.status === 429) break;
    }
    V.patchSteps(steps);
  }
  await stopOcr();
  problems.forEach((m) => toast(m, 'error'));
  state.docs.push(...added);
  if (!state.docs.length) { state.busy = null; render(); return; }
  if (!added.length) { state.busy = null; render(); return; }
  await runAnalysis(steps);
}

async function addPasted(name, text) {
  if (!text.trim()) return toast('Paste some text first.', 'error');
  if (!(await ensureConsent())) return undefined;
  const doc = makeTextDoc(`d${state.nextDoc++}`, name.trim() || 'Pasted text', text, 'paste');
  state.docs.push(doc);
  closeSheet();
  return runAnalysis();
}

async function loadSamples() {
  try {
    const { documents } = await api.getSamples();
    state.docs = documents.map((d) => ({ ...d, warnings: [] }));
    state.nextDoc = documents.length + 1;
    await runAnalysis();
  } catch (e) { toast(e.message, 'error'); }
}

async function runMissing() {
  if (!state.analysis) return;
  const key = state.analysis.meta.generatedAt;
  const show = () => { if (sheetKind === 'missing' && sheet().open) fillSheet(V.missingSheet(state, actions)); };
  state.missingError = null;
  if (state.missing && state.missing.forKey === key) { state.missingBusy = false; openSheet(V.missingSheet(state, actions), 'missing'); return; }
  state.missingBusy = true;
  openSheet(V.missingSheet(state, actions), 'missing');
  try {
    const r = await withAccess(() => api.missing(serverDocs(), slim(state.analysis), todayISO()));
    state.missing = { ...r, forKey: key };
    save();
  } catch (e) { state.missingError = e.message; }
  state.missingBusy = false;
  show();
}

// ---------- actions (passed to the views) ----------
function pick(accept, capture) {
  const input = h('input', { type: 'file', accept, multiple: !capture, ...(capture ? { capture: 'environment' } : {}), class: 'sr', tabindex: '-1' });
  input.addEventListener('change', () => { addFiles(input.files); input.remove(); });
  document.body.append(input);
  input.click();
}

const actions = {
  go,
  pickFiles: () => pick('.pdf,application/pdf,image/*,.txt,.md,text/plain'),
  pickPhoto: () => pick('image/*', true),
  loadSamples,
  pasteText() {
    const name = h('input', { class: 'field', type: 'text', 'aria-label': 'Name for this document', placeholder: 'Name, e.g. Discharge instructions' });
    const area = h('textarea', { class: 'field', rows: '10', 'aria-label': 'Document text', placeholder: 'Paste the text of a prescription, report or discharge note' });
    openSheet({ title: 'Paste text', subtitle: 'Useful for documents you can already copy from an email or website.',
      body: [name, area, h('div', { class: 'drop__btns' }, h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'), h('button', { type: 'button', class: 'btn btn--primary', onclick: () => addPasted(name.value, area.value) }, 'Add and analyze'))] }, 'paste');
    setTimeout(() => area.focus(), 50);
  },
  analyze: () => runAnalysis(),
  retry: () => (state.lastAction ? state.lastAction() : runAnalysis()),
  dismissError() { state.error = null; state.busy = null; render(); },
  runMissing,
  showBrief: () => go('brief'),
  setFilter(f) { state.filter = f; render(); },
  openSources(f) { openSheet(V.sourcesSheet(f, actions), 'sources'); },
  openSource(s) { closeSheet(); actions.viewDoc(s.docId, s.page, s.quote); },
  viewDoc(id, page, quote) {
    state.viewer = id ? { docId: id, page: page || 1, quote: quote || '' } : null;
    if (state.route !== 'documents') { state.route = 'documents'; if (location.hash !== '#/documents') { history.replaceState(null, '', '#/documents'); } }
    render();
    if (state.viewer) requestAnimationFrame(() => { const hit = $('#hit'); (hit || $('.viewer'))?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  },
  async removeDoc(id) {
    const d = state.docs.find((x) => x.id === id);
    if (!d || !(await ask({ title: 'Remove this document?', body: [`"${d.name}" will be removed from this session and the remaining documents will be analyzed again.`], confirm: 'Remove', danger: true }))) return;
    if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
    state.docs = state.docs.filter((x) => x.id !== id);
    state.viewer = null;
    if (!state.docs.length) { wipe(); render(); return; }
    await runAnalysis();
  },
  async clearAll() {
    if (!(await ask({ title: 'Clear everything?', body: ['This removes your documents, findings and brief from this device. Nothing is stored on the server, so it cannot be recovered.'], confirm: 'Clear everything', danger: true }))) return;
    wipe();
    location.hash = '#/overview';
    render();
    toast('Everything was cleared from this device.');
  },
  async copy(text, msg) { toast((await copyText(text)) ? msg : 'Copy was blocked by the browser.', 'info'); },
  async share(text) { try { await navigator.share({ title: 'Doctor Visit Brief', text }); } catch { /* cancelled */ } },
};

// ---------- boot ----------
function setupDragDrop() {
  const over = (on) => document.querySelectorAll('.drop').forEach((d) => d.classList.toggle('is-over', on));
  document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); over(true); } });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) over(false); });
  document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); over(false); addFiles(e.dataTransfer.files); } });
}

async function boot() {
  restore();
  try { state.health = await api.getHealth(); } catch {
    state.health = { mode: 'rules', provider: 'none', limits: { maxDocs: 10, maxPagesPerDoc: 60 }, offline: true };
    toast('CareBridge could not reach its server. Check that it is running.', 'error');
  }
  const r = location.hash.replace(/^#\/?/, '');
  if (ROUTES.some((x) => x[0] === r)) state.route = r;
  sheet().addEventListener('click', (e) => { if (e.target === sheet()) closeSheet(); });
  sheet().addEventListener('close', () => { sheetKind = null; });
  window.addEventListener('hashchange', onHash);
  setupDragDrop();
  render();
}
boot();
