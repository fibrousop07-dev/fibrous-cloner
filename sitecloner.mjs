#!/usr/bin/env node
// fibrous-cloner CLI (formerly SiteCloner) - copy a website's frontend, serve it on localhost, let you confirm.
//   node sitecloner.mjs <url>            clone + serve + confirm
//   node sitecloner.mjs serve <folder>   serve an existing clone
// Flags: --out <dir> --port <n> --max <files> --no-open --answer <y|n|s>
// Zero dependencies (Node 18+).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// FIBROUS_SITES_<name>, falling back to the pre-rename SITECLONER_<name> (with a one-time deprecation note).
const warnedEnv = new Set();
function envOpt(name) {
  const v = process.env['FIBROUS_SITES_' + name]; if (v) return v;
  const old = process.env['SITECLONER_' + name];
  if (old && !warnedEnv.has(name)) { warnedEnv.add(name); console.warn(`SITECLONER_${name} is deprecated, use FIBROUS_SITES_${name}`); }
  return old || '';
}
const CLONES = envOpt('CLONES') ? path.resolve(envOpt('CLONES')) : path.join(HERE, 'clones');
// clone bookkeeping files keep their _sitecloner* names so existing clones keep working
const META = '_sitecloner.json';
// Use Node's native HTTP identity; an obsolete impersonated Chrome UA causes some CDNs to refuse valid downloads.
const ASSET_EXT = 'png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|glb|gltf|bin|txt|xml|webmanifest|wasm|hdr|ktx2|map';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm',
};
const REWRITE_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.webmanifest']);

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['out', 'port', 'max', 'answer'].includes(k)) flags[k] = argv[++i]; else flags[k] = true;
  } else pos.push(a);
}

// ---------- helpers ----------
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c(2, s), green = (s) => c(32, s), yellow = (s) => c(33, s), red = (s) => c(31, s), bold = (s) => c(1, s);
const stripWww = (h) => h.replace(/^www\./i, '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const segSafe = (s) => s.replace(/[<>:"|?*\x00-\x1f\\]/g, '_').replace(/[. ]+$/, '');

function toRel(pn, isHtml) {
  let p;
  try { p = decodeURIComponent(pn); } catch { p = pn; }
  const endsSlash = p.endsWith('/');
  const segs = p.split('/').filter((s) => s && s !== '.' && s !== '..').map(segSafe).filter(Boolean);
  if (endsSlash || segs.length === 0) segs.push('index.html');
  else if (isHtml && !path.extname(segs[segs.length - 1])) segs.push('index.html');
  return segs.join(path.sep);
}

// Optional hooks for hosted use: urlGuard(url) throws to refuse a request (SSRF protection), maxBody caps one response.
let urlGuard = null, maxBody = 0;
function setFetchLimits(opts = {}) { urlGuard = opts.urlGuard || null; maxBody = opts.maxBody || 0; }

async function get(u, extra = {}, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30000);
  try {
  let url = u, res;
  for (let hop = 0; ; hop++) {
    if (urlGuard) await urlGuard(new URL(url));
    res = await fetch(url, { headers: { Accept: '*/*', ...extra }, redirect: urlGuard ? 'manual' : 'follow', signal: controller.signal });
    if (urlGuard && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= 5) throw new Error('too many redirects');
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    break;
  }
  if (maxBody && Number(res.headers.get('content-length') || 0) > maxBody) throw new Error('response too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBody && buf.length > maxBody) throw new Error('response too large');
  return { url: urlGuard ? url : res.url, ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', waf: res.headers.get('x-amzn-waf-action') || '', buf };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

// ---------- API snapshot ----------
// Saves the site's PUBLIC, read-only API answers (plain GETs, no cookies, no login) so the localhost copy can
// replay them. It cannot copy server code, databases or anything behind a login.
const API_FILE = '_sitecloner-api.json';
const API_SKIP = /\/(admin|logout|signout|sign-out|delete|remove|unsubscribe|callback|oauth|webhook|checkout|payment|pay)(\/|$)/i;

function apiKey(pathname, pairs) {
  const sp = [...pairs].sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0])));
  return pathname + (sp.length ? '?' + sp.map(([k, v]) => `${k}=${v}`).join('&') : '');
}

// APIs often say what they accept, e.g. {"error":"realm must be one of lifesteal, practice"}
function parseHint(text) {
  const m = /([A-Za-z_][\w-]*)\s+must be (?:one of|either)\s+([^"}\n]+)/i.exec(text);
  if (!m) return null;
  const values = m[2].split(/,|\bor\b|\|/).map((s) => s.trim().replace(/[.'"]+$/, '')).filter((s) => /^[\w.\-]{1,30}$/.test(s)).slice(0, 12);
  return values.length ? { name: m[1], values } : null;
}

// finds "/api/..." calls in page code, plus the query-parameter names used next to each one
function collectApi(text, apiMap) {
  for (const m of text.matchAll(/["'`](\/api\/[\w\-/]*)/g)) {
    const p = m[1].replace(/\/{2,}/g, '/');
    let e = apiMap.get(p);
    if (!e) { e = { names: new Set() }; apiMap.set(p, e); }
    const near = text.slice(m.index, m.index + 260);
    for (const q of near.matchAll(/[?&]([A-Za-z_][\w-]{0,19})=/g)) e.names.add(q[1]);
  }
}

async function snapshotApi({ origin, endpoints, out, signal }) {
  const siteKey = stripWww(new URL(origin).hostname);
  const entries = {};
  const missing = new Map(); // path -> why it could not be copied
  let requests = 0;
  const MAX_REQ = 1000;
  const aborted = () => { if (signal?.aborted) throw new Error('cancelled'); };

  const call = async (pathname, pairs) => {
    if (requests++ >= MAX_REQ) return null;
    const u = new URL(pathname, origin);
    for (const [k, v] of pairs) u.searchParams.append(k, v);
    try {
      const r = await get(u.href, { Accept: 'application/json, */*;q=0.5' });
      if (stripWww(new URL(r.url).hostname) !== siteKey) return null;
      return { ...r, text: r.buf.toString('utf8') };
    } catch { return null; }
  };
  const store = (pathname, pairs, r) => {
    if (r.buf.length > 2e6 || !/json|text/.test(r.type)) return false;
    entries[apiKey(pathname, pairs)] = { status: r.status, type: r.type || 'application/json', body: r.text };
    return true;
  };
  const ok = (r) => r && r.status >= 200 && r.status < 300;

  const plain = [], withId = [];
  for (const [p, info] of endpoints) {
    if (API_SKIP.test(p + '/')) { missing.set(p, 'admin or account-changing endpoint, skipped on purpose'); continue; }
    (p.endsWith('/') ? withId : plain).push([p, info]);
  }

  // 1) endpoints without an id: probe bare, then follow "must be one of ..." hints to enumerate parameter values
  for (const [p, info] of plain) {
    aborted();
    const names = [...info.names].slice(0, 6);
    const seen = new Set(), probed = new Set(), queue = [[]];
    let n = 0, stored = false, last = 0;
    while (queue.length && n < 24) {
      const pairs = queue.shift();
      const key = apiKey(p, pairs);
      if (seen.has(key)) continue;
      seen.add(key); n++;
      const r = await call(p, pairs);
      if (!r) break;
      last = r.status;
      if (r.status === 400) {
        const h = parseHint(r.text);
        if (h && !pairs.some(([k]) => k === h.name)) for (const v of h.values) queue.push([...pairs, [h.name, v]]);
        continue;
      }
      if (ok(r) || r.status === 401) { store(p, pairs, r); stored = true; } // 401 = "logged out" answer, which is exactly what a visitor sees
      if (ok(r)) {
        for (const nm of names) { // ask about parameters the page code uses, using a bogus value to make the API list the real ones
          if (pairs.some(([k]) => k === nm)) continue;
          const pk = key + '|' + nm;
          if (probed.has(pk)) continue;
          probed.add(pk); n++;
          const pr = await call(p, [...pairs, [nm, '__probe__']]);
          if (pr && pr.status === 400) { const h = parseHint(pr.text); if (h && h.name === nm) for (const v of h.values) queue.push([...pairs, [nm, v]]); }
        }
      }
    }
    if (!stored) {
      missing.set(p, last === 0 ? 'could not be reached'
        : last === 400 ? 'needs parameters the API did not reveal'
        : last === 404 ? 'no public GET answer (404): probably a POST-only or sub-path endpoint'
        : `no usable public answer (HTTP ${last})`);
    }
  }

  // 2) endpoints that take an id in the path (e.g. /api/player/<name>): use real names/uuids seen in the data above
  const people = [];
  const walk = (v, d = 0) => {
    if (people.length >= 8 || d > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
    if (typeof v.uuid === 'string' && typeof v.name === 'string' && !/^0{8}-/.test(v.uuid) && !people.some((q) => q.uuid === v.uuid)) people.push({ uuid: v.uuid, name: v.name });
    Object.values(v).forEach((x) => walk(x, d + 1));
  };
  for (const e of Object.values(entries)) if (e.status === 200) { try { walk(JSON.parse(e.body)); } catch { /* not json */ } }
  if (people.length) {
    for (const [p] of withId) {
      aborted();
      const first = await call(p + encodeURIComponent(people[0].uuid), []);
      if (first && (first.status === 401 || first.status === 403)) { missing.set(p, 'needs a login'); continue; }
      if (ok(first)) store(p + encodeURIComponent(people[0].uuid), [], first);
      const jobs = [];
      for (const person of people) for (const id of [person.uuid, person.name]) if (!(person === people[0] && id === person.uuid)) jobs.push(p + encodeURIComponent(id));
      for (let i = 0; i < jobs.length; i += 4) {
        aborted();
        await Promise.all(jobs.slice(i, i + 4).map(async (pth) => { const r = await call(pth, []); if (ok(r)) store(pth, [], r); }));
      }
    }
  } else for (const [p] of withId) missing.set(p, 'needs an id, and no real ids were found in the saved data');

  const takenAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, API_FILE), JSON.stringify({ takenAt, origin, entries }));
  return {
    entries: Object.keys(entries).length,
    ...summarizeEntries(entries, withId.map(([p]) => p)),
    missing: [...missing].map(([p, reason]) => ({ path: p, reason })),
    takenAt, requests,
  };
}

// counts + short endpoint lists for the panel. "/api/player/abc" -> "/api/player/<id>" so the list stays readable
function summarizeEntries(entries, idPrefixes = []) {
  const okPaths = new Set(), gatedPaths = new Set();
  let captured = 0;
  for (const [k, e] of Object.entries(entries)) {
    const bp = k.split('?')[0];
    if (e.status >= 200 && e.status < 300) {
      captured++;
      const pre = idPrefixes.find((x) => bp.startsWith(x) && bp.length > x.length);
      okPaths.add(pre ? pre + '<id>' : bp);
    } else if (e.status === 401 || e.status === 403) gatedPaths.add(bp);
  }
  return { captured, savedPaths: [...okPaths].sort(), gated: [...gatedPaths].sort() };
}

// ---------- crawl ----------
async function crawl(startUrl, out, maxFiles, onProgress, signal, opts = {}) {
  const first = await get(startUrl, {}, signal);
  // Bot protection often answers a script with 202 and an empty page (a challenge only a real browser can pass).
  // Saving that would leave a blank clone, so stop with a clear message instead.
  if (!first.ok || first.status === 202 || first.buf.length === 0) {
    throw new Error(first.status === 202 || first.buf.length === 0
      ? 'The site refused to give its page to a script (bot protection answered HTTP ' + first.status + ' with an empty page' + (first.waf ? ', ' + first.waf : '') + '). Open the site in your own browser, press Ctrl+S, then use Import saved page here.'
      : 'The site answered HTTP ' + first.status + ', so there is nothing to copy.');
  }
  const base = new URL(first.url);
  const origin = base.origin;
  const siteKey = stripWww(base.hostname);
  const sameSite = (u) => /^https?:$/.test(u.protocol) && stripWww(u.hostname) === siteKey;

  fs.mkdirSync(out, { recursive: true });
  const seen = new Set();
  const queue = [];
  const saved = new Set();
  const failed = [];
  // incremental byte counter (no directory walking); opts.maxBytes stops the crawl instead of saving past the cap
  const sizes = new Map(); let bytes = 0, capped = false;
  const capError = () => Object.assign(new Error('size limit'), { code: 'SIZE_CAP' });
  const apiMap = new Map(); // "/api/x" -> { names: parameter names seen next to it in the page code }
  const spaRoutes = new Set();
  let homeHash = null;

  const enqueue = (raw, from) => {
    if (!raw) return;
    raw = raw.trim();
    // Ignore malformed serialized CDN paths instead of crawling them as local pages.
    if (/^\/https?:?\//i.test(raw)) return;
    if (!raw || /^(data:|mailto:|tel:|javascript:|blob:|#)/i.test(raw)) return;
    let u;
    try { u = new URL(raw, from); } catch { return; }
    if (!sameSite(u)) return;
    u.hash = '';
    if (/^\/(api|socket\.io|graphql|trpc)(\/|$)/.test(u.pathname)) return;
    if (opts.allowUrl && !opts.allowUrl(u.href)) return; // robots.txt (hosted use)
    const key = u.pathname + u.search;
    if (seen.has(key)) return;
    seen.add(key);
    // origin + path, not new URL(path, origin): a path starting "//" would be read as another host
    queue.push(new URL(origin + u.pathname + u.search));
  };

  const scan = (text, type, from) => {
    if (/html/.test(type)) {
      for (const m of text.matchAll(/\b(?:href|src|data-src|data-href|data-poster|poster)\s*=\s*["']([^"']+)["']/gi)) enqueue(m[1], from);
      for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const p of m[1].split(',')) enqueue(p.trim().split(/\s+/)[0], from);
      for (const m of text.matchAll(/<meta\b[^>]*>/gi)) {
        if (/image|tile/i.test(m[0])) { const cm = /content\s*=\s*["']([^"']+)["']/i.exec(m[0]); if (cm) enqueue(cm[1], from); }
      }
    }
    if (/css|html/.test(type)) {
      for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) enqueue(m[1], from);
      for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) enqueue(m[1], from);
    }
    if (/javascript|html|json/.test(type)) {
      const re = new RegExp(`["'\`]((?:\\.{0,2}/)?[\\w@%\\-./]+\\.(?:${ASSET_EXT}))(?:\\?[^"'\`]*)?["'\`]`, 'gi');
      for (const m of text.matchAll(re)) if (!/^(https?:)?\/\//i.test(m[1])) enqueue(m[1], from);
      for (const m of text.matchAll(/import\s*(?:[^'"`]*from\s*)?["']([^"']+)["']/g)) enqueue(m[1], from);
      for (const m of text.matchAll(/["'`](https?:\/\/[^"'`\s)]+)["'`]/g)) enqueue(m[1], from);
      collectApi(text, apiMap);
    }
    if (/xml/.test(type)) for (const m of text.matchAll(/<loc>([^<]+)<\/loc>/g)) enqueue(m[1], from);
  };

  const recent = [];
  const handle = (r) => {
    const fu = new URL(r.url);
    if (!sameSite(fu)) return;
    const isHtml = /html/.test(r.type);
    const ext = path.extname(fu.pathname);
    const firstPage = homeHash === null && isHtml;
    if (firstPage) homeHash = sha(r.buf);
    else if (isHtml && !ext && fu.pathname !== '/' && sha(r.buf) === homeHash) { spaRoutes.add(fu.pathname); return; }
    const file = path.join(out, toRel(fu.pathname, isHtml));
    if (!path.resolve(file).startsWith(path.resolve(out))) return;
    const home = path.join(out, 'index.html');
    const homeCopy = firstPage && file !== home ? Buffer.from(r.buf.toString('utf8').replace(/<base\b[^>]*>/gi, '').replace(/<head\b[^>]*>/i, m => m + '<base href="' + fu.pathname.replace(/"/g, '%22') + '">')) : null;
    const nb = bytes - (sizes.get(file) || 0) + r.buf.length + (homeCopy ? homeCopy.length : 0);
    if (opts.maxBytes && nb > opts.maxBytes) { capped = true; return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.buf);
    sizes.set(file, r.buf.length); bytes = nb;
    saved.add(file);
    // A language/region redirect still needs a home page for the localhost server.
    if (homeCopy) { fs.writeFileSync(home, homeCopy); sizes.set(home, homeCopy.length); saved.add(home); }
    recent.push({ p: path.relative(out, file).split(path.sep).join('/'), s: r.buf.length });
    if (/text|javascript|json|xml|html|css/.test(r.type) && r.buf.length < 64e6) scan(r.buf.toString('utf8'), r.type, fu.href);
  };

  seen.add(base.pathname + base.search);
  handle(first);
  for (const extra of ['/', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/manifest.webmanifest', '/site.webmanifest']) enqueue(extra, origin);

  while (queue.length && saved.size < maxFiles) {
    if (signal?.aborted) throw new Error('cancelled');
    if (capped) throw capError();
    const batch = queue.splice(0, 16);
    await Promise.all(batch.map(async (u) => {
      try {
        const r = await get(u.href, {}, signal);
        if (!r.ok || (r.status === 202 && r.buf.length === 0)) { if (r.status !== 404) failed.push(`${u.pathname} -> HTTP ${r.status}`); return; }
        handle(r);
      } catch (e) { failed.push(`${u.pathname} -> ${e.message}`); }
    }));
    if (capped) throw capError();
    if (onProgress) onProgress(saved.size, queue.length, recent.splice(0));
    else process.stdout.write(`\r  ${dim('crawling')} ${saved.size} files, ${queue.length} queued   `);
  }
  if (!onProgress) process.stdout.write('\n');

  let apiSnap = null;
  if (opts.snapshotApi !== false && apiMap.size) {
    opts.onPhase?.('api');
    try { apiSnap = await snapshotApi({ origin, endpoints: apiMap, out, signal }); }
    catch (e) { if (e.message === 'cancelled') throw e; apiSnap = null; }
  }
  // merge with any earlier metadata so re-downloading one layer never wipes the other
  const prev = readMeta(out) || {};
  const meta = { ...prev, url: startUrl, origin, host: base.hostname, createdAt: prev.createdAt || new Date().toISOString() };
  if (apiMap.size) meta.endpoints = Object.fromEntries([...apiMap].map(([p, e]) => [p, [...e.names]]));
  if (apiSnap) meta.backend = backendMeta(apiSnap);
  if (capped) throw capError();
  writeMeta(out, meta);
  return { meta, bytes: bytes + JSON.stringify(meta, null, 2).length, saved: saved.size, failed, apiCalls: [...apiMap.keys()].sort(), spaRoutes: [...spaRoutes], apiSnap };
}

// ---------- layers: a clone = Frontend (website files) + Backend data (saved public API answers) ----------
const backendMeta = (s) => ({ takenAt: s.takenAt, captured: s.captured, savedPaths: s.savedPaths, gated: s.gated, missing: s.missing });
function readMeta(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8')); } catch { return null; } }
function writeMeta(dir, meta) { fs.writeFileSync(path.join(dir, META), JSON.stringify(meta, null, 2)); }

function walkFiles(dir, cb) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, cb);
    else if (!e.name.startsWith('_sitecloner')) { try { cb(p, fs.statSync(p)); } catch { /* ignore */ } }
  }
}

function frontendStats(dir) {
  let files = 0, bytes = 0;
  walkFiles(dir, (_, st) => { files++; bytes += st.size; });
  let hasIndex = false;
  try { hasIndex = fs.statSync(path.join(dir, 'index.html')).size > 0; } catch { /* none */ }
  return { files, bytes, hasIndex };
}

function backendStats(dir) {
  const f = path.join(dir, API_FILE);
  if (!fs.existsSync(f)) return null;
  const b = (readMeta(dir) || {}).backend || {};
  let bytes = 0;
  try { bytes = fs.statSync(f).size; } catch { /* ignore */ }
  return { captured: b.captured || 0, savedPaths: b.savedPaths || [], gated: b.gated || [], missing: b.missing || [], takenAt: b.takenAt || '', bytes };
}

// (re)download only the backend data of an existing clone. Endpoints come from the saved list, or are found by
// reading the clone's own JS/HTML files, so this also works on clones made before this feature existed.
async function refreshApi(dir, signal) {
  const meta = readMeta(dir);
  if (!meta) throw new Error('not a fibrous-cloner clone folder');
  let endpoints = new Map(Object.entries(meta.endpoints || {}).map(([p, names]) => [p, { names: new Set(names) }]));
  if (!endpoints.size) {
    walkFiles(dir, (f, st) => { if (/\.(m?js|html?)$/i.test(f) && st.size < 8e6) { try { collectApi(fs.readFileSync(f, 'utf8'), endpoints); } catch { /* ignore */ } } });
  }
  meta.endpoints = Object.fromEntries([...endpoints].map(([p, e]) => [p, [...e.names]]));
  if (!endpoints.size) { // nothing to ask for: a static site, or the frontend was deleted before it was ever checked
    delete meta.backend;
    writeMeta(dir, meta);
    return { entries: 0, captured: 0, savedPaths: [], gated: [], missing: [], none: true };
  }
  const snap = await snapshotApi({ origin: meta.origin, endpoints, out: dir, signal });
  meta.backend = backendMeta(snap);
  writeMeta(dir, meta);
  return snap;
}

function deleteFrontend(dir) { // keeps only the tool's own files (metadata + saved API data)
  for (const e of fs.readdirSync(dir)) if (!e.startsWith('_sitecloner')) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
}
function deleteBackend(dir) { // keeps the endpoint list so the data can be downloaded again
  fs.rmSync(path.join(dir, API_FILE), { force: true });
  const m = readMeta(dir);
  if (m) { delete m.backend; writeMeta(dir, m); }
}

// ---------- import a page that the user's own browser saved (Ctrl+S) ----------
// Some sites hand a script an empty page (bot protection, or server-side rendering that only a real browser completes).
// The user's browser loads the page for real, Ctrl+S writes it to disk, and this turns that save into a clone.
// Supports "Webpage, Complete" (an .html file plus a "<name>_files" folder) and "Webpage, Single File" (.mhtml).
const SAVED_EXT = /\.(html?|mhtml?|mht)$/i;
const isSavedPage = (f) => SAVED_EXT.test(String(f));
const isMhtml = (f) => /\.(mhtml?|mht)$/i.test(f);

function cleanUrl(u) {
  try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
}
function titleOf(html) { const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 120) : ''; }

function decodeQP(s) { // quoted-printable -> bytes
  const bytes = [];
  s = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 255);
  }
  return Buffer.from(bytes);
}

function parseMhtml(buf) {
  const text = buf.toString('latin1'); // keeps every byte; text parts are decoded from the bytes later
  const split = (t) => { const m = /\r?\n\r?\n/.exec(t); return m ? [t.slice(0, m.index), t.slice(m.index + m[0].length)] : [t, '']; };
  const hdrs = (h) => {
    const o = {};
    for (const line of h.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
    return o;
  };
  const [top, rest] = split(text);
  const headers = hdrs(top);
  const bm = /boundary="?([^";\s]+)"?/i.exec(headers['content-type'] || '');
  if (!bm) throw new Error('That file is not a saved web page');
  const parts = [];
  for (const chunk of rest.split('--' + bm[1]).slice(1)) {
    if (chunk.startsWith('--')) break;
    const [ph, pb] = split(chunk.replace(/^\r?\n/, ''));
    const h2 = hdrs(ph), cte = (h2['content-transfer-encoding'] || '').toLowerCase();
    const raw = pb.replace(/\r?\n$/, '');
    const body = cte === 'base64' ? Buffer.from(raw.replace(/\s+/g, ''), 'base64') : cte === 'quoted-printable' ? decodeQP(raw) : Buffer.from(raw, 'latin1');
    parts.push({ type: (h2['content-type'] || '').split(';')[0].trim().toLowerCase(), location: h2['content-location'] || '', body });
  }
  return { headers, parts };
}

function findAssetsDir(file, html) {
  const dir = path.dirname(file), base = path.basename(file).replace(/\.[^.]+$/, '');
  const direct = path.join(dir, base + '_files');
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  try { // other languages name it differently ("_fichiers", "_files"...): find the folder the page actually points at
    const m = /(?:src|href)=["']([^"'/]+_[^"'/]*)\//i.exec(html || '');
    if (m) { const d = path.join(dir, decodeURIComponent(m[1])); if (fs.existsSync(d) && fs.statSync(d).isDirectory()) return d; }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name.startsWith(base) && /_(files|fichiers|archivos|dateien)$/i.test(e.name)) return path.join(dir, e.name);
  } catch { /* none */ }
  return null;
}

// what is inside a saved page: its address (browsers write it into the file), title, and whether its files came along
function inspectSaved(file) {
  if (!isSavedPage(file)) throw new Error('Pick the .html or .mhtml file your browser saved');
  let st; try { st = fs.statSync(file); } catch { throw new Error('That file could not be found'); }
  if (!st.isFile() || st.size === 0) throw new Error('That file is empty');
  if (st.size > 400e6) throw new Error('That file is too large to import');
  if (isMhtml(file)) {
    const { headers, parts } = parseMhtml(fs.readFileSync(file));
    const html = parts.find((p) => p.type === 'text/html');
    if (!html) throw new Error('No web page was found inside that file');
    return { kind: 'mhtml', url: cleanUrl(headers['snapshot-content-location'] || html.location), title: titleOf(html.body.toString('utf8')), hasAssets: parts.length > 1 };
  }
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(Math.min(st.size, 400000));
  try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  const head = buf.toString('utf8');
  let url = '';
  const saved = /<!--\s*saved from url=\(\d+\)([^>]*?)\s*-->/i.exec(head); // Chrome and Edge write the page's address here
  if (saved) url = cleanUrl(saved[1]);
  if (!url) for (const tag of head.match(/<link\b[^>]*>/gi) || []) if (/rel=["']?canonical/i.test(tag)) { const h2 = /href=["']([^"']+)["']/i.exec(tag); if (h2) { url = cleanUrl(h2[1]); break; } }
  if (!url) { const og = /<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i.exec(head) || /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["']/i.exec(head); if (og) url = cleanUrl(og[1]); }
  return { kind: 'html', url, title: titleOf(head), hasAssets: !!findAssetsDir(file, head) };
}

// Turns a saved page into a clone folder. outDir may be a folder, or a function(host) that picks one once the site is known.
function importSaved({ file, url, outDir, stripScripts = true, existing = false, asHome = false }) {
  const info = inspectSaved(file);
  const pageUrl = cleanUrl(url) || info.url;
  if (!pageUrl) { const e = new Error('Enter the address of the site this page came from'); e.needsUrl = true; throw e; }
  const u = new URL(pageUrl), siteKey = stripWww(u.hostname);
  const dir = typeof outDir === 'function' ? outDir(u.hostname) : outDir;
  const prev = readMeta(dir) || {};
  if (existing && prev.origin && stripWww(new URL(prev.origin).hostname) !== siteKey) throw new Error('That page is from a different site than this clone');
  fs.mkdirSync(dir, { recursive: true });
  const inside = (f) => path.resolve(f).startsWith(path.resolve(dir) + path.sep);
  const writeAt = (rel, content) => { const f = path.join(dir, rel); if (!inside(f)) return; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  const pagePath = !u.pathname || u.pathname === '/' ? null : toRel(u.pathname, true);
  const strip = (h) => {
    h = h.replace(/<!--\s*saved from url=[^>]*-->\s*/i, '');
    if (stripScripts) h = h.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, '').replace(/<link\b[^>]*\brel=["']?(?:modulepreload|preload)["']?[^>]*>/gi, '');
    return h;
  };
  const savePage = (html) => {
    if (!pagePath || !existing || asHome) writeAt('index.html', html); // a new clone (or a repair) always gets a home page to start from
    if (pagePath) writeAt(pagePath, /<base\b/i.test(html) ? html : html.replace(/<head\b[^>]*>/i, (m) => m + '<base href="/">')); // nested pages find their files from the site root
  };

  let standalone = true; // true when the page is one self-contained file (inline CSS, embedded images)
  if (info.kind === 'mhtml') {
    const { parts } = parseMhtml(fs.readFileSync(file));
    const main = parts.find((p) => p.type === 'text/html');
    const written = new Set(), ext = [];
    const plan = [];
    for (const p of parts) {
      if (p === main || !p.location) continue;
      let pu; try { pu = new URL(p.location); } catch { continue; }
      if (!/^https?:$/.test(pu.protocol)) continue;
      if (stripScripts && /javascript|ecmascript/.test(p.type)) continue;
      const same = stripWww(pu.hostname) === siteKey;
      const rel = same ? toRel(pu.pathname, false) : path.join('_ext', segSafe(pu.hostname), toRel(pu.pathname, false));
      ext.push([p.location, '/' + rel.split(path.sep).join('/')]);
      plan.push({ p, rel });
    }
    if (plan.length) standalone = false;
    const relink = (t) => { for (const [abs, local] of ext) t = t.split(abs).join(local).split(abs.replace(/&/g, '&amp;')).join(local); return t; };
    for (const { p, rel } of plan) {
      if (written.has(rel)) continue;
      written.add(rel);
      writeAt(rel, p.type === 'text/css' ? Buffer.from(relink(p.body.toString('utf8'))) : p.body);
    }
    savePage(strip(relink(main.body.toString('utf8'))).replace(/<base\b[^>]*>/gi, ''));
  } else {
    let html = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const assets = findAssetsDir(file, html);
    if (assets) {
      const name = path.basename(assets);
      let dest = name, n = 2;
      while (fs.existsSync(path.join(dir, dest))) dest = `${name}-${n++}`;
      standalone = false;
      fs.cpSync(assets, path.join(dir, dest), { recursive: true });
      if (dest !== name) html = html.split(encodeURI(name) + '/').join(encodeURI(dest) + '/').split(name + '/').join(dest + '/'); // two saves with the same title keep separate files folders
    }
    savePage(strip(html));
  }
  let saved = 0;
  walkFiles(dir, () => { saved++; });
  writeMeta(dir, { ...prev, url: prev.url || pageUrl, origin: prev.origin || u.origin, host: prev.host || u.hostname, createdAt: prev.createdAt || new Date().toISOString(), source: prev.source || 'saved page' });
  return { saved, standalone, page: pagePath || 'index.html', url: pageUrl, dir };
}

// After a saved page is imported, fetch what it still points at on the web (fonts, images, stylesheets, files the browser did not
// save) so the clone also works offline. Same-site files are saved at their own paths; files on other sites go under _ext/<host>/
// and the page is re-linked to them. Everything is best effort: whatever cannot be fetched keeps its original link.
async function fetchMissingAssets(dir, pageUrl, { stripScripts = true, max = 3000, deadlineMs = 300000 } = {}) {
  const base = new URL(pageUrl), siteKey = stripWww(base.hostname);
  const end = Date.now() + deadlineMs;
  let fetched = 0, failed = 0;
  const tried = new Set();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const localFor = (u) => (stripWww(u.hostname) === siteKey ? toRel(u.pathname, false) : path.join('_ext', segSafe(u.hostname), toRel(u.pathname, false)));
  const refsIn = (text, isHtml) => {
    const out = new Set();
    const add = (raw) => {
      raw = String(raw || '').trim().replace(/&amp;/g, '&');
      if (!raw || /^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(raw)) return;
      if (/^(https?:)?\/\//i.test(raw) || (raw.startsWith('/') && !raw.startsWith('//'))) out.add(raw); // saved pages already link their own files relatively
    };
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);
    for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) add(m[1]);
    if (isHtml) {
      for (const tag of text.match(/<link\b[^>]*>/gi) || []) { const h2 = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag); if (h2 && /rel\s*=\s*["']?[^"'>]*(stylesheet|icon|preload|apple-touch)/i.test(tag)) add(h2[1]); }
      for (const m of text.matchAll(/<(?:img|source|video|audio|track|embed|input)\b[^>]*?\b(?:src|poster)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
      for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0]);
      if (!stripScripts) for (const m of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
    }
    return out;
  };
  for (let round = 0; round < 3 && fetched < max && Date.now() < end; round++) {
    const files = [];
    walkFiles(dir, (f) => { if (/\.(html?|css)$/i.test(f)) files.push(f); });
    const want = new Map(); // original text -> absolute URL
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const raw of refsIn(text, /\.html?$/i.test(f))) {
        let abs; try { abs = new URL(raw.startsWith('//') ? base.protocol + raw : raw, base); } catch { continue; }
        if (!/^https?:$/.test(abs.protocol)) continue;
        if (stripScripts && /\.m?js$/i.test(abs.pathname)) continue;
        if (fs.existsSync(path.join(dir, localFor(abs))) || tried.has(abs.href)) continue;
        want.set(raw, abs);
      }
    }
    if (!want.size) break;
    const rewrites = [];
    const queue = [...want.entries()];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length && fetched < max && Date.now() < end) {
        const [raw, abs] = queue.shift();
        if (tried.has(abs.href)) continue;
        tried.add(abs.href);
        try {
          const r = await get(abs.href);
          if (!r.ok || r.status === 202 || r.buf.length === 0 || r.buf.length > 25e6 || (/html/.test(r.type) && !/\.html?$/i.test(abs.pathname))) { failed++; continue; } // an HTML answer to an asset request is an error page
          const rel = localFor(abs), f = path.join(dir, rel);
          if (!path.resolve(f).startsWith(path.resolve(dir) + path.sep)) { failed++; continue; }
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, r.buf);
          fetched++;
          if (stripWww(abs.hostname) !== siteKey) rewrites.push([raw, '/' + rel.split(path.sep).join('/')]);
        } catch { failed++; }
      }
    }));
    if (rewrites.length) { // point the page and stylesheets at the local copies of other sites' files
      for (const f of files.concat((() => { const x = []; walkFiles(dir, (g) => { if (/\.css$/i.test(g)) x.push(g); }); return x; })())) {
        let text = fs.readFileSync(f, 'utf8'), changed = false;
        for (const [raw, local] of rewrites) {
          for (const variant of new Set([raw, raw.replace(/&/g, '&amp;')])) {
            const re = new RegExp(esc(variant) + '(?=["\')\\s,>])', 'g');
            if (re.test(text)) { text = text.replace(re, local); changed = true; }
          }
        }
        if (changed) fs.writeFileSync(f, text);
      }
    }
  }
  return { fetched, failed };
}

// ---------- server ----------
function makeServer(dir, getPort) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
  const siteKey = stripWww(new URL(meta.origin).hostname);
  const originRe = new RegExp(`https?:\\/\\/(?:www\\.)?${esc(siteKey)}`, 'gi');
  const stats = { healed: [], blocked: new Set(), missing: new Set(), snapshotHits: 0 };
  const root = path.resolve(dir);
  const snapFile = path.join(dir, API_FILE);
  let snap = null, snapDoc = null; // saved public API answers, if this clone has them
  try { snapDoc = JSON.parse(fs.readFileSync(snapFile, 'utf8')); snap = snapDoc.entries; } catch { /* none */ }
  // "learning": an answer the clone doesn't have yet is fetched ONCE from the live site (plain GET, no cookies or login),
  // saved, and replayed from then on. Only runs for clones that already have backend data, and can be switched off.
  let learn = meta.learn !== false;
  stats.learned = 0;
  let persistTimer = null;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (!fs.existsSync(snapFile)) { learn = false; return; } // backend data was deleted meanwhile: do not bring it back
      try {
        fs.writeFileSync(snapFile, JSON.stringify({ ...snapDoc, entries: snap }));
        const m = readMeta(dir);
        if (m) {
          m.backend = { ...(m.backend || {}), ...summarizeEntries(snap, Object.keys(m.endpoints || {}).filter((p) => p.endsWith('/'))) };
          writeMeta(dir, m);
        }
      } catch { /* ignore */ }
    }, 800);
  };

  const findFile = (pn) => {
    for (const rel of [toRel(pn, false), toRel(pn, true)]) {
      let f = path.join(dir, rel);
      try {
        if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
        if (fs.statSync(f).isFile() && path.resolve(f).startsWith(root)) return f;
      } catch { /* not there */ }
    }
    return null;
  };

  const send = (res, req, file, buf) => {
    const ext = path.extname(file).toLowerCase();
    let body = buf ?? fs.readFileSync(file);
    if (REWRITE_EXT.has(ext)) body = Buffer.from(body.toString('utf8').replace(originRe, `http://localhost:${getPort()}`));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let pn;
    try { pn = decodeURIComponent(u.pathname); } catch { pn = u.pathname; }
    if (path.basename(pn).startsWith('_sitecloner')) { res.writeHead(404); return res.end('not found'); } // tool bookkeeping stays private
    if (snap && req.method === 'GET' && pn.startsWith('/api/')) {
      const hit = snap[apiKey(u.pathname, u.searchParams.entries())];
      if (hit) {
        stats.snapshotHits++;
        res.writeHead(hit.status, { 'Content-Type': hit.type, 'Cache-Control': 'no-store', 'X-Fibrous-Sites': 'snapshot' });
        return res.end(hit.body);
      }
    }
    if (snap && learn && req.method === 'GET' && pn.startsWith('/api/') && !API_SKIP.test(pn + '/') && Object.keys(snap).length < 20000) {
      try {
        const r = await get(new URL(meta.origin + u.pathname + u.search).href, { Accept: 'application/json, */*;q=0.5' });
        const good = (r.status >= 200 && r.status < 300) || r.status === 401; // 401 = the logged-out answer a visitor sees
        if (stripWww(new URL(r.url).hostname) === siteKey && good && /json|text/.test(r.type) && r.buf.length < 2e6) {
          snap[apiKey(u.pathname, u.searchParams.entries())] = { status: r.status, type: r.type || 'application/json', body: r.buf.toString('utf8') };
          stats.learned++;
          persist();
          res.writeHead(r.status, { 'Content-Type': r.type || 'application/json', 'Cache-Control': 'no-store', 'X-Fibrous-Sites': 'learned' });
          return res.end(r.buf);
        }
      } catch { /* offline or blocked: fall through to the 503 stub */ }
    }
    if (/^\/(api|socket\.io|graphql|trpc)(\/|$)/.test(pn) || !['GET', 'HEAD'].includes(req.method)) {
      stats.blocked.add(pn);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'backend not cloned' }));
    }
    const f = findFile(pn);
    if (f) return send(res, req, f);
    if (path.extname(pn)) {
      // static-looking file we never saw (runtime-built name): pull it from the live site once and keep it
      try {
        const r = await get(new URL(meta.origin + u.pathname + u.search).href);
        if (r.ok && !/html/.test(r.type)) {
          const target = path.join(dir, toRel(pn, false));
          if (path.resolve(target).startsWith(root)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, r.buf);
            stats.healed.push(pn);
            return send(res, req, target, r.buf);
          }
        }
      } catch { /* fall through */ }
      stats.missing.add(pn);
      res.writeHead(404);
      return res.end('not found');
    }
    const idx = findFile('/');
    if (idx) return send(res, req, idx);
    res.writeHead(404);
    res.end('no index.html');
  });
  return { server, stats, meta, setLearn: (v) => { learn = !!v; } };
}

async function listen(dir, wantPort) {
  let port = Number(wantPort) || 4300;
  const holder = { port };
  const built = makeServer(dir, () => holder.port);
  for (let tries = 0; tries < 50; tries++, port++) {
    try {
      await new Promise((resolve, reject) => {
        built.server.once('error', reject);
        built.server.listen(port, '127.0.0.1', () => { built.server.removeListener('error', reject); resolve(); });
      });
      holder.port = port;
      return { ...built, port };
    } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no free port');
}

// ---------- main ----------
function normalizeUrl(s) {
  s = s.trim().replace(/\\([:./])/g, '$1').replace(/\\$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return new URL(s).href;
}

async function serveFlow(dir, { askConfirm, openIt, port, deletable }) {
  const { server, stats, meta, port: p } = await listen(dir, port);
  const url = `http://localhost:${p}/`;
  console.log(`\n  ${green('Serving')} ${bold(url)}   ${dim(dir)}`);
  if (openIt) openBrowser(url);
  const summary = () => {
    if (stats.snapshotHits) console.log(`  ${dim('answered from the API snapshot:')} ${stats.snapshotHits} request(s)`);
    if (stats.healed.length) console.log(`  ${dim('filled from live site while browsing:')} ${stats.healed.length} file(s)`);
    if (stats.missing.size) console.log(`  ${yellow('still missing:')} ${[...stats.missing].slice(0, 8).join(', ')}`);
    if (stats.blocked.size) console.log(`  ${dim('backend calls stubbed (503):')} ${[...stats.blocked].slice(0, 8).join(', ')}`);
  };
  if (!askConfirm) {
    console.log(dim('  Ctrl+C to stop.'));
    return 'serve';
  }
  const hint = `\n  Does it look right?  [y] keep   [n] delete   [s] keep serving (Ctrl+C to stop)\n  > `;
  let ans = flags.answer ?? (await ask(hint));
  if (flags.answer) { await new Promise((r) => setTimeout(r, Number(flags.wait || 0))); console.log(`  > ${ans}`); }
  ans = ans.toLowerCase();
  if (ans === 's') { summary(); console.log(dim('  Serving. Ctrl+C to stop.')); return 'serve'; }
  summary();
  server.close();
  if (ans === 'n') {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  ${red('Deleted')} ${dir}`);
  } else {
    console.log(`  ${green('Kept')} ${bold(dir)}`);
    console.log(dim(`  Serve it again any time:  node "${fileURLToPath(import.meta.url)}" serve "${dir}"`));
  }
  return ans;
}

async function main() {
  if (flags.help || flags.h) {
    console.log('fibrous-cloner — local website cloner\nUsage:\n  fibrous-cloner <url>             copy site, serve on localhost, confirm\n  fibrous-cloner serve <folder>    serve an existing clone\nFlags: --out <dir> --port <n> --max <files> --no-open --no-api --answer <y|n|s>');
    return;
  }
  if (pos[0] === 'ui') { await import('./ui.mjs'); return; }
  if (pos[0] === 'serve') {
    const dir = path.resolve(pos[1] || '.');
    if (!fs.existsSync(path.join(dir, META))) throw new Error(`${dir} is not a fibrous-cloner clone folder (no ${META})`);
    await serveFlow(dir, { askConfirm: false, openIt: !flags['no-open'], port: flags.port });
    return;
  }
  let input = pos[0];
  if (!input) { await import('./ui.mjs'); return; } // no URL given: open the control panel
  const url = normalizeUrl(input);
  console.log(`\n  ${bold('fibrous-cloner')}  ${url}`);
  console.log(dim('  Only clone sites you own or have permission to copy. Frontend only: no server code or database.'));

  const host = new URL(url).hostname.replace(/^www\./, '');
  let out = flags.out ? path.resolve(flags.out) : path.join(CLONES, host);
  if (fs.existsSync(out)) out += '-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

  const { cloneWithBrowser } = await import('./browser-clone.mjs');
  const r = await cloneWithBrowser(url, out, Number(flags.max) || 100000, null, null, { snapshotApi: !flags['no-api'] });
  console.log(`  ${green('Saved')} ${r.saved} files from ${r.meta.origin}`);
  if (r.apiSnap) console.log(`  ${green('Backend data:')} ${r.apiSnap.captured} public answer(s) saved${r.apiSnap.gated.length ? dim(' · need a login: ' + r.apiSnap.gated.join(' ')) : ''}${r.apiSnap.missing.length ? dim(' · not capturable: ' + r.apiSnap.missing.map((m) => m.path).join(' ')) : ''}`);
  if (r.spaRoutes.length) console.log(`  ${dim('client-side routes detected (served via index.html):')} ${r.spaRoutes.length}`);
  if (r.apiCalls.length) console.log(`  ${yellow('Backend calls found (not cloned, will be stubbed):')} ${r.apiCalls.slice(0, 10).join(' ')}`);
  if (r.failed.length) console.log(`  ${yellow('Failed:')} ${r.failed.length} (first: ${r.failed[0]})`);
  if (r.saved === 0) throw new Error('nothing was saved');

  const res = await serveFlow(out, { askConfirm: true, openIt: !flags['no-open'], port: flags.port });
  if (res !== 'serve') process.exit(0);
}

export { envOpt, setFetchLimits, fetchMissingAssets, inspectSaved, importSaved, isSavedPage, crawl, listen, normalizeUrl, openBrowser, CLONES, META, readMeta, writeMeta, refreshApi, frontendStats, backendStats, deleteFrontend, deleteBackend };

// run the CLI only when executed directly (ui.mjs imports this file as a library)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(red('\n  Error: ') + e.message); if (process.env.DEBUG) console.error(e.stack); process.exit(1); });
}
