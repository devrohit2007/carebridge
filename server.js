// CareBridge server. Zero dependencies (Node >= 18). Nothing is written to disk and request bodies are never logged.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { analyzeDocuments, findMissing, transcribeImage } from './src/analyze.js';
import { ROOT, loadConfig, loadDotenv, publicInfo } from './src/config.js';
import { ApiError } from './src/errors.js';
import { buildSampleDocuments } from './src/samples.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);

const CSP = [
  "default-src 'self'",
  // jsdelivr is only used to lazy-load the on-device OCR fallback (tesseract.js). Remove it if you never need OCR.
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, cfg) {
  const h = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  const proto = cfg.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  if (proto === 'https') h['Strict-Transport-Security'] = 'max-age=15552000';
  return h;
}

function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

function makeRateLimiter({ max, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.min(windowMs, 60000));
  timer.unref();
  return (ip) => {
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(ip, e);
    }
    e.count += 1;
    return { ok: e.count <= max, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  };
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const codeMatches = (given, expected) => crypto.timingSafeEqual(digest(given), digest(expected));

function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload), ...extra });
  res.end(payload);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new ApiError(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json).'));
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new ApiError(413, 'too_large', 'That request is too large.'));
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(new ApiError(413, 'too_large', 'That request is too large.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'invalid_json', 'The request was not valid JSON.'));
      }
      return undefined;
    });
    req.on('error', reject);
    return undefined;
  });
}

const gzipCache = new Map();

async function serveStatic(req, res, url, cfg) {
  const headers = securityHeaders(req, cfg);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
    return res.end();
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, headers);
    return res.end();
  }
  if (rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.'))) {
    res.writeHead(404, headers);
    return res.end('Not found');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, headers);
    return res.end();
  }
  try {
    let file = abs;
    let st = await fs.stat(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fs.stat(file);
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const base = { ...headers, 'Content-Type': type, 'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' };
    const wantsGzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && st.size > 1024;
    if (wantsGzip) {
      const cached = gzipCache.get(file);
      let buf;
      if (cached && cached.mtimeMs === st.mtimeMs) buf = cached.buf;
      else {
        buf = zlib.gzipSync(await fs.readFile(file), { level: 6 });
        gzipCache.set(file, { mtimeMs: st.mtimeMs, buf });
      }
      res.writeHead(200, { ...base, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': buf.length });
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    const body = await fs.readFile(file);
    res.writeHead(200, { ...base, 'Content-Length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
}

export function createApp(cfg, { limiter = makeRateLimiter(cfg.rateLimit), fetchImpl, nowFn } = {}) {
  const runOpts = () => ({ ...(fetchImpl ? { fetchImpl } : {}), ...(nowFn ? { now: nowFn() } : {}), ...(process.env.CAREBRIDGE_TEST ? { retryDelayMs: 1 } : {}) });

  async function api(req, res, url) {
    const headers = { ...securityHeaders(req, cfg), 'Cache-Control': 'no-store' };
    const send = (status, body, extra) => sendJson(res, status, body, { ...headers, ...extra });
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return send(200, publicInfo(cfg));
      if (url.pathname === '/api/samples' && req.method === 'GET') return send(200, { documents: buildSampleDocuments(nowFn ? nowFn() : new Date()) });

      const routes = { '/api/analyze': analyzeDocuments, '/api/missing': findMissing, '/api/transcribe': transcribeImage };
      const handler = routes[url.pathname];
      if (!handler) return send(404, { error: { code: 'not_found', message: 'Unknown endpoint.' } });
      if (req.method !== 'POST') return send(405, { error: { code: 'method_not_allowed', message: 'Use POST.' } }, { Allow: 'POST' });

      if (cfg.accessCode) {
        const given = req.headers['x-access-code'];
        if (typeof given !== 'string' || !codeMatches(given, cfg.accessCode)) {
          return send(401, { error: { code: 'access_code_required', message: given ? 'That access code is not correct.' : 'Enter the access code to continue.' } });
        }
      }
      const rl = limiter(clientIp(req, cfg));
      if (!rl.ok) return send(429, { error: { code: 'rate_limited', message: `Too many requests. Try again in ${Math.ceil(rl.retryAfter / 60)} minute(s).` } }, { 'Retry-After': String(rl.retryAfter) });

      const limit = url.pathname === '/api/transcribe' ? Math.ceil(cfg.limits.maxImageBytes * 1.4) + 4096 : cfg.limits.maxBodyBytes;
      const body = await readJson(req, limit);
      const result = await handler(body, cfg, runOpts());
      return send(200, result);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(e.status, { error: { code: e.code, message: e.message } }, e.status === 413 ? { Connection: 'close' } : {});
      }
      console.error(`[error] ${req.method} ${url.pathname}: ${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 200)}`);
      return send(500, { error: { code: 'internal_error', message: 'Something went wrong on the server. Please try again.' } });
    }
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/') && process.env.CAREBRIDGE_QUIET !== '1') {
      res.on('finish', () => console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    }
    const run = url.pathname.startsWith('/api/') ? api(req, res, url) : serveStatic(req, res, url, cfg);
    run.catch((e) => {
      console.error('[fatal]', e?.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 5000;
  return server;
}

function main() {
  loadDotenv();
  const cfg = loadConfig();
  const server = createApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    const where = cfg.host === '0.0.0.0' ? 'all interfaces' : cfg.host;
    console.log(`\nCareBridge is running  ->  http://localhost:${cfg.port}  (listening on ${where})`);
    console.log(cfg.ai.provider === 'none' ? 'Mode: rules-only (no AI model configured)' : `Mode: AI via ${cfg.ai.provider} (${cfg.ai.model})`);
    if (cfg.accessCode) console.log('Access code: required');
    for (const w of cfg.warnings) console.log(`Note: ${w}`);
    console.log('Press Ctrl+C to stop.\n');
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use. Set PORT to another number.` : e.message);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
