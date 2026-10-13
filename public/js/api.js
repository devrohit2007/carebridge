// Thin fetch wrapper. Errors become ApiError with a message that is safe to show to the person.
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

let accessCode = '';
try { accessCode = sessionStorage.getItem('carebridge.code') || ''; } catch { /* storage blocked */ }
export function setAccessCode(code) {
  accessCode = code;
  try { sessionStorage.setItem('carebridge.code', code); } catch { /* ignore */ }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, signal,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(accessCode ? { 'x-access-code': accessCode } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'offline', 'CareBridge could not reach the server. Check that it is still running and that you are online.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code || 'error', data?.error?.message || `The server answered with an error (${res.status}).`);
  return data;
}

export const getHealth = () => request('/api/health');
export const getSamples = () => request('/api/samples');
export const analyze = (documents, today, signal, aiMode) => request('/api/analyze', { method: 'POST', body: { documents, today, ...(aiMode ? { aiMode } : {}) }, signal });
export const missing = (documents, analysis, today, signal) => request('/api/missing', { method: 'POST', body: { documents, analysis, today }, signal });
export const transcribe = (name, mime, data, signal) => request('/api/transcribe', { method: 'POST', body: { name, mime, data }, signal });

/** Only text + page numbers leave the device. Files, previews and local metadata stay behind. */
export const forServer = (docs) => docs.map((d) => ({ id: d.id, name: d.name, origin: d.origin, unit: d.unit, ocrConfidence: d.ocrConfidence ?? null, pages: d.pages }));
