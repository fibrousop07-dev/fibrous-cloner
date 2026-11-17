// fibrous-cloner control panel: paste a URL, press Clone, then press "Start localhost".
// Run: FibrousSites.cmd  (or: node ui.mjs [--no-open] [--port 4200])
import { cloneWithBrowser, captureClone } from './browser-clone.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { envOpt, crawl, listen, normalizeUrl, openBrowser, CLONES, META, readMeta, writeMeta, refreshApi, frontendStats, backendStats, deleteFrontend, deleteBackend, inspectSaved, importSaved, isSavedPage, fetchMissingAssets } from './sitecloner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = envOpt('STATE') || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FibrousSites');
const STATE_FILE = path.join(STATE_DIR, 'panel.json');
const argv = process.argv.slice(2);
const IS_APP = argv.includes('--app'); // launched by the Start-menu app: quit when its window closes
const noOpen = argv.includes('--no-open');
const pi = argv.indexOf('--port');
const WANT_PORT = pi >= 0 ? Number(argv[pi + 1]) : 4200;

fs.mkdirSync(CLONES, { recursive: true });
const running = new Map(); // clone name -> { server, port, stats }
const jobs = new Map();
let jobSeq = 0;

const safeName = (n) => typeof n === 'string' && /^[\w.\-]+$/.test(n) && !n.includes('..');

// ---- organising: folders are REAL directories inside the clones folder, so the disk mirrors the app ----
// (tags live in each clone's metadata). A directory with a _sitecloner.json is a clone; any other directory is a folder.
const SEG_BAD = /[<>:"|?*\\/\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_DEPTH = 4;
const lower = (x) => String(x).toLowerCase();
const insideOf = (child, parent) => { const c = lower(path.resolve(child)), q = lower(path.resolve(parent)); return c === q || c.startsWith(q + path.sep); };
function cleanSeg(n) {
  const t = String(n ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40 || SEG_BAD.test(t) || /[. ]$/.test(t) || t.startsWith('.') || t.startsWith('_sitecloner') || RESERVED.test(t)) {
    throw new Error('Folder names need 1 to 40 characters, cannot contain \\ / : * ? " < > |, and cannot start or end with a dot');
  }
  return t;
}
function folderSegs(p) {
  const segs = String(p ?? '').split('/').map((x) => x.trim()).filter(Boolean).map(cleanSeg);
  if (segs.length > MAX_DEPTH) throw new Error('Folders can be nested up to ' + MAX_DEPTH + ' levels');
  return segs;
}
const isActiveJob = (j) => j.state === 'queued' || j.state === 'running';

// a directory holding loose files is an unfinished/imported copy, never an organising folder
const hasFiles = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isFile()); } catch { return false; } };
// every clone and folder under the clones folder, with where it lives
function scan() {
  const fresh = new Set([...jobs.values()].filter((j) => j.kind === 'clone' && isActiveJob(j)).map((j) => j.name)); // a copy still being written is not a folder
  const clones = [], folders = [];
  const walk = (dir, rel, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('_sitecloner') || e.name.startsWith('.')) continue;
      if (depth === 0 && fresh.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, META))) clones.push({ name: e.name, dir: full, folder: rel });
      else if (depth < MAX_DEPTH && !hasFiles(full)) { const r = rel ? rel + '/' + e.name : e.name; folders.push(r); walk(full, r, depth + 1); }
    }
  };
  walk(CLONES, '', 0);
  return { clones, folders: folders.sort((x, y) => lower(x).localeCompare(lower(y))) };
}
const locate = (n) => (safeName(n) ? (scan().clones.find((c) => c.name === n) || {}).dir || null : null);
const cloneDir = (n) => locate(n) || path.join(CLONES, n);

function folderAbs(p) { // an existing folder (or the clones folder itself for '')
  const segs = folderSegs(p);
  let d = CLONES;
  for (const s2 of segs) d = path.join(d, s2);
  if (segs.length) {
    let st; try { st = fs.statSync(d); } catch { throw new Error('Unknown folder'); }
    if (!st.isDirectory() || fs.existsSync(path.join(d, META))) throw new Error('Unknown folder');
  }
  return d;
}
const depthOfDir = (abs) => path.relative(CLONES, abs).split(path.sep).filter(Boolean).length;
function heightOf(dir) { // how many folder levels are below this one
  let h2 = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !fs.existsSync(path.join(dir, e.name, META))) h2 = Math.max(h2, 1 + heightOf(path.join(dir, e.name))); } catch { /* ignore */ }
  return h2;
}
function busyInside(dirAbs) {
  for (const j of jobs.values()) {
    if (!isActiveJob(j)) continue;
    const d = locate(j.name) || (j.kind === 'clone' ? path.join(CLONES, j.name) : null);
    if (d && insideOf(d, dirAbs)) return true;
  }
  return false;
}
function stopInside(dirAbs) { // a running clone serves files from its folder, so it is stopped before the folder moves
  let n = 0;
  for (const name of [...running.keys()]) { const d = locate(name); if (d && insideOf(d, dirAbs)) { stopClone(name); n++; } }
  return n;
}
function moveDir(from, toParent) { // returns false (already there), true, or 'stopped' (moved after stopping a running clone)
  const name = path.basename(from), target = path.join(toParent, name);
  if (lower(path.resolve(path.dirname(from))) === lower(path.resolve(toParent))) return false;
  if (insideOf(toParent, from)) throw new Error('A folder cannot go inside itself');
  const isClone = fs.existsSync(path.join(from, META)); // a site's own sub-folders (assets, fonts...) are not folder levels
  if (!isClone && depthOfDir(toParent) + 1 + heightOf(from) > MAX_DEPTH) throw new Error('Folders can be nested up to ' + MAX_DEPTH + ' levels');
  if (fs.existsSync(target)) throw new Error('"' + name + '" already exists in that folder');
  if (busyInside(from)) throw new Error('Wait for the running copy to finish first');
  const stopped = stopInside(from);
  try { fs.renameSync(from, target); } catch { throw new Error('Could not move it. Close anything that is using the folder and try again'); }
  return stopped ? 'stopped' : true;
}
function folderAction(body) {
  const action = body.action;
  if (action === 'create') {
    const parent = folderAbs(body.parent || '');
    const name = cleanSeg(body.name);
    if (depthOfDir(parent) + 1 > MAX_DEPTH) throw new Error('Folders can be nested up to ' + MAX_DEPTH + ' levels');
    if (fs.readdirSync(parent).some((x) => lower(x) === lower(name))) throw new Error('Something called "' + name + '" is already in there');
    fs.mkdirSync(path.join(parent, name));
    return false;
  }
  const abs = folderAbs(body.path);
  if (abs === CLONES) throw new Error('Unknown folder');
  if (action === 'rename') {
    const to = cleanSeg(body.to), target = path.join(path.dirname(abs), to);
    if (path.basename(abs) === to) return false;
    if (lower(path.basename(abs)) !== lower(to) && fs.existsSync(target)) throw new Error('Something called "' + to + '" is already in there');
    if (busyInside(abs)) throw new Error('Wait for the running copy to finish first');
    const stopped = stopInside(abs);
    try { fs.renameSync(abs, target); } catch { throw new Error('Could not rename it. Close anything that is using the folder and try again'); }
    return !!stopped;
  }
  if (action === 'move') return moveDir(abs, folderAbs(body.parent || '')) === 'stopped';
  if (action === 'delete') { // never deletes a site: everything inside moves up one level first
    const parent = path.dirname(abs), kids = fs.readdirSync(abs, { withFileTypes: true });
    if (kids.some((k) => !k.isDirectory())) throw new Error('This folder holds other files, so it was left alone');
    for (const k of kids) if (fs.existsSync(path.join(parent, k.name))) throw new Error('"' + k.name + '" already exists one level up, rename it first');
    if (busyInside(abs)) throw new Error('Wait for the running copy to finish first');
    const stopped = stopInside(abs);
    for (const k of kids) fs.renameSync(path.join(abs, k.name), path.join(parent, k.name));
    fs.rmdirSync(abs);
    return !!stopped;
  }
  throw new Error('unknown action');
}
const cleanTag = (t) => String(t ?? '').replace(/[\x00-\x1f]/g, '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 24);
function organizeClone(name, body) {
  let dir = locate(name);
  if (!dir) throw new Error('unknown clone');
  let stopped = false;
  if ('folder' in body) {
    const to = folderAbs(body.folder || '');
    stopped = moveDir(dir, to) === 'stopped';
    dir = locate(name) || dir;
  }
  if ('tags' in body) {
    const m = readMeta(dir);
    if (!Array.isArray(body.tags)) throw new Error('tags must be a list');
    const out = [];
    for (const raw of body.tags) { const t = cleanTag(raw); if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t); }
    if (out.length > 12) throw new Error('A site can have up to 12 tags');
    if (out.length) m.tags = out; else delete m.tags;
    writeMeta(dir, m);
  }
  return stopped;
}
// an earlier version kept folders in a registry file plus a "folder" field in each clone: turn those into real folders once
(function migrateOldFolders() {
  const file = path.join(CLONES, '_sitecloner-folders.json');
  try {
    if (!fs.existsSync(file)) return;
    const reg = JSON.parse(fs.readFileSync(file, 'utf8')).folders || [];
    for (const f of reg) { try { fs.mkdirSync(path.join(CLONES, cleanSeg(f)), { recursive: true }); } catch { /* skip bad names */ } }
    for (const c of scan().clones) {
      const m = readMeta(c.dir);
      if (!m || !m.folder) continue;
      let dir = c.dir;
      try {
        const target = path.join(CLONES, cleanSeg(m.folder));
        fs.mkdirSync(target, { recursive: true });
        if (!c.folder && !fs.existsSync(path.join(target, c.name))) { fs.renameSync(c.dir, path.join(target, c.name)); dir = path.join(target, c.name); }
      } catch { /* leave it where it is */ }
      delete m.folder; writeMeta(dir, m);
    }
    fs.renameSync(file, file + '.migrated');
  } catch { /* nothing to migrate */ }
})();

// does the home page look empty (a site that only shows its content to a real browser)? Returns why, or ''.
function pageLooksEmpty(dir) {
  try {
    const f = path.join(dir, 'index.html'), st = fs.statSync(f);
    if (st.size < 400) return 'The home page is almost empty.';
    const html = fs.readFileSync(f, 'utf8').slice(0, 1500000);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&\w+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 60 && !/<(img|svg|canvas|video|picture)\b/i.test(html)) return 'The home page has almost no visible content.';
  } catch { return 'The home page is missing.'; }
  return '';
}

// the browser's own "open file" window (Windows), so a saved page can be picked without typing a path
function pickSavedFile() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('The file picker is only available on Windows. Use "Watch Downloads" instead.'));
    const ps = "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='Choose the page your browser saved'; $d.Filter='Saved web page (*.html;*.htm;*.mhtml;*.mht)|*.html;*.htm;*.mhtml;*.mht|All files (*.*)|*.*'; $d.InitialDirectory=[Environment]::GetFolderPath('UserProfile')+'\\Downloads'; if($d.ShowDialog($f) -eq 'OK'){[Console]::Out.Write($d.FileName)}";
    const pr = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
    let out = '';
    pr.stdout.on('data', (d) => { out += d; });
    pr.on('error', reject);
    pr.on('close', () => resolve(out.trim()));
  });
}
// pages saved (Ctrl+S) in the last while, newest first: lets the app notice a save without any file picking
function recentSavedPages(since) {
  const out = [];
  for (const dir of [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')]) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !isSavedPage(e.name)) continue;
      const f = path.join(dir, e.name);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < since) continue;
      let assets = 0; try { assets = fs.readdirSync(f.replace(/\.[^.]+$/, '') + '_files').length; } catch { /* single file */ }
      out.push({ path: f, name: e.name, size: st.size, mtime: st.mtimeMs, assets });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 5);
}

function listClones() {
  const out = [];
  for (const c of scan().clones) {
    const dir = c.dir, meta = readMeta(dir);
    if (!meta) continue;
    const r = running.get(c.name);
    out.push({
      name: c.name, origin: meta.origin || '', createdAt: meta.createdAt || '',
      frontend: frontendStats(dir),               // the website files
      backend: backendStats(dir),                 // saved public API answers (null = none saved)
      endpointsChecked: !!meta.endpoints || !!meta.backend,
      endpointsKnown: Object.keys(meta.endpoints || {}).length,
      learn: meta.learn !== false,
      folder: c.folder || '', tags: Array.isArray(meta.tags) ? meta.tags : [],
      running: r ? { port: r.port, healed: r.stats.healed.length, stubbed: r.stats.blocked.size, snapshotHits: r.stats.snapshotHits, learned: r.stats.learned } : null,
    });
  }
  return out.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
}

// ---- job queue: any number of sites can be queued; up to MAX_PARALLEL are copied at the same time ----
let MAX_PARALLEL = 3;
const isActive = (j) => j.state === 'queued' || j.state === 'running';
const jobView = ({ controller, ...rest }) => rest;

function uniqueName(host) {
  const taken = (n) => fs.existsSync(cloneDir(n)) || [...jobs.values()].some((j) => j.name === n && isActive(j));
  if (!taken(host)) return host;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  let name = `${host}-${stamp}`;
  for (let i = 2; taken(name); i++) name = `${host}-${stamp}-${i}`;
  return name;
}

function addJobs(inputs, auto, api) {
  const added = [], skipped = [];
  for (const raw of inputs) {
    let url;
    try {
      url = normalizeUrl(raw);
      const h = new URL(url).hostname;
      if (!h.includes('.') && h !== 'localhost') throw new Error('no domain'); // rejects stray words like "not"
    } catch { skipped.push({ input: raw, reason: 'not a valid URL' }); continue; }
    if ([...jobs.values()].some((j) => j.url === url && isActive(j))) { skipped.push({ input: raw, reason: 'already in the queue' }); continue; }
    const host = new URL(url).hostname.replace(/^www\./, '');
    const job = { id: ++jobSeq, kind: 'clone', url, name: uniqueName(host), auto: !!auto, api: api !== false, phase: 'files', state: 'queued', saved: 0, queued: 0, error: null, result: null, finishedAt: null, controller: new AbortController() };
    jobs.set(job.id, job);
    added.push(jobView(job));
  }
  pump();
  return { added, skipped };
}

// download just one layer (backend data or frontend files) of a clone that already exists
function addLayerJob(name, kind) {
  if ([...jobs.values()].some((j) => isActive(j) && j.name === name)) throw new Error('something is already running for this clone');
  const meta = readMeta(cloneDir(name));
  if (!meta) throw new Error('unknown clone');
  const job = { id: ++jobSeq, kind, url: meta.url || meta.origin, name, auto: false, api: false, phase: kind === 'backend' ? 'api' : 'files', state: 'queued', saved: 0, queued: 0, error: null, result: null, finishedAt: null, controller: new AbortController() };
  jobs.set(job.id, job);
  pump();
  return jobView(job);
}
function assertIdle(name) {
  if ([...jobs.values()].some((j) => isActive(j) && j.name === name)) throw new Error('wait for the running job on this clone to finish');
}

function pump() {
  let free = MAX_PARALLEL - [...jobs.values()].filter((j) => j.state === 'running').length;
  for (const j of jobs.values()) {
    if (free <= 0) break;
    if (j.state === 'queued') { free--; runJob(j); }
  }
}

function runJob(job) {
  job.state = 'running';
  const out = cloneDir(job.name);
  if (job.kind === 'backend') { // existing clone: only (re)download its backend data; the frontend is never touched
    refreshApi(out, job.controller.signal)
      .then((r) => { job.result = { snapshot: r.captured, gated: r.gated, uncaptured: r.missing, none: !!r.none }; job.state = 'done'; job.finishedAt = Date.now(); })
      .catch((e) => { job.state = job.controller.signal.aborted ? 'cancelled' : 'error'; job.error = e.message; job.finishedAt = Date.now(); })
      .finally(pump);
    return;
  }
  const layerOnly = job.kind !== 'clone'; // existing clone: re-download website files only, keep the saved backend data
  const download = job.kind === 'browser' ? (url, dir, max, progress, signal, opts) => captureClone(url, dir, { signal, onPhase: opts.onPhase }) : cloneWithBrowser;
  download(job.url, out, 100000, (n, q) => { job.saved = n; job.queued = q; }, job.controller.signal, { snapshotApi: layerOnly ? false : job.api, onPhase: (p) => { job.phase = p; } })
    .then(async (r) => {
      if (r.saved === 0) throw new Error('nothing was saved');
      job.saved = r.saved;
      job.result = { rendered: !!r.rendered, browserError: r.browserError || null, saved: r.saved, api: r.apiCalls, snapshot: r.apiSnap ? r.apiSnap.captured : 0, gated: r.apiSnap ? r.apiSnap.gated : [], uncaptured: r.apiSnap ? r.apiSnap.missing : [], failed: r.failed.length, spa: r.spaRoutes.length };
      job.result.suspect = r.browserError || pageLooksEmpty(out); // asks the user to double-check pages that came back (almost) empty
      job.state = 'done';
      job.finishedAt = Date.now();
      if (job.auto) { try { await startClone(job.name); } catch { /* user can press Start localhost */ } }
    })
    .catch((e) => {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'error';
      job.error = e.message;
      job.finishedAt = Date.now();
      if (!layerOnly) fs.rmSync(out, { recursive: true, force: true }); // a failed fresh clone leaves nothing; a failed re-download never deletes what you already had
    })
    .finally(pump);
}

function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return;
  if (j.state === 'queued') { j.state = 'cancelled'; j.finishedAt = Date.now(); }
  else if (j.state === 'running') j.controller.abort(); // the crawler notices within a moment and cleans up
}

function listJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.state === 'done' && now - j.finishedAt > 20000) jobs.delete(id);
    if (j.state === 'cancelled' && now - j.finishedAt > 4000) jobs.delete(id);
  }
  return { parallel: MAX_PARALLEL, jobs: [...jobs.values()].map(jobView) };
}

async function startClone(name) {
  if (running.has(name)) return running.get(name);
  const r = await listen(cloneDir(name), 4300);
  running.set(name, r);
  return r;
}

function stopClone(name) {
  const r = running.get(name);
  if (!r) return;
  r.server.close();
  r.server.closeAllConnections?.();
  running.delete(name);
}

const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const sse = new Set();
let idleTimer = null;
let port = WANT_PORT;
function shutdown() {
  for (const j of jobs.values()) {
    if (!isActive(j)) continue; // unfinished copies are discarded so no half-copied folders are left behind
    j.controller.abort();
    if (j.kind === 'clone') { try { fs.rmSync(cloneDir(j.name), { recursive: true, force: true }); } catch { /* ignore */ } } // never touch a clone that already existed
  }
  for (const n of [...running.keys()]) stopClone(n);
  try { if (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pid === process.pid) fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }
  process.exit(0);
}
function armIdle(ms) {
  if (!IS_APP) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (sse.size === 0) shutdown(); }, ms);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const panel = http.createServer(async (req, res) => {
  // local-only panel: refuse odd Host headers (DNS rebinding) and require a custom header on writes (CSRF)
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden'); }
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && u.pathname === '/api/ping') return json(res, 200, { app: 'fibrous-sites', pid: process.pid, port });
  if (req.method === 'GET' && u.pathname === '/icon.png') {
    try { const b = fs.readFileSync(path.join(HERE, 'icon.png')); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(b); }
    catch { res.writeHead(404); return res.end(); }
  }
  if (req.method === 'GET' && u.pathname === '/api/events') {
    // open connection = "window is alive". When it drops (window closed) the app shuts itself down.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    sse.add(res);
    clearTimeout(idleTimer);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); sse.delete(res); if (sse.size === 0) armIdle(8000); });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/clones') return json(res, 200, listClones());
  if (req.method === 'GET' && u.pathname === '/api/jobs') return json(res, 200, listJobs());
  if (req.method === 'GET' && u.pathname === '/api/folders') return json(res, 200, { folders: scan().folders });
  if (req.method === 'POST') {
    if (req.headers['x-fibrous-sites'] !== '1') return json(res, 403, { error: 'missing header' });
    const body = await readBody(req);
    try {
      if (u.pathname === '/api/clone') {
        // accepts one URL or many (space, comma or newline separated) and adds them all to the queue
        const list = [].concat(body.urls ?? body.url ?? []).join(' ').split(/[\s,]+/).filter(Boolean).slice(0, 100);
        if (!list.length) return json(res, 400, { error: 'paste at least one URL' });
        return json(res, 200, addJobs(list, body.auto, body.api));
      }
      if (u.pathname === '/api/cancel') { cancelJob(Number(body.id)); return json(res, 200, { ok: true }); }
      if (u.pathname === '/api/dismiss') { const j = jobs.get(Number(body.id)); if (j && !isActive(j)) jobs.delete(j.id); return json(res, 200, { ok: true }); }
      if (u.pathname === '/api/settings') { MAX_PARALLEL = Math.min(12, Math.max(1, Number(body.parallel) || 3)); pump(); return json(res, 200, { parallel: MAX_PARALLEL }); }
      if (u.pathname === '/api/import/pick') return json(res, 200, { path: await pickSavedFile() });
      if (u.pathname === '/api/import/recent') return json(res, 200, { files: recentSavedPages(Number(body.since) || 0) });
      if (u.pathname === '/api/import/inspect') { const f = String(body.path || ''); if (!path.isAbsolute(f)) throw new Error('Pick the .html or .mhtml file your browser saved'); return json(res, 200, inspectSaved(f)); }
      if (u.pathname === '/api/import') { // turn a page the user's own browser saved (Ctrl+S) into a clone, or into an existing one
        const file = String(body.path || '');
        if (!path.isAbsolute(file) || !isSavedPage(file)) throw new Error('Pick the .html or .mhtml file your browser saved');
        let into = null, made = null;
        if (body.into) { if (!safeName(body.into) || !locate(body.into)) throw new Error('unknown clone'); assertIdle(body.into); into = body.into; }
        try {
          const r = importSaved({ file, url: body.url, stripScripts: body.stripScripts !== false, existing: !!into, asHome: !!body.asHome,
            outDir: into ? cloneDir(into) : (host) => { made = path.join(CLONES, uniqueName(host.replace(/^www\./, ''))); return made; } });
          let extra = { fetched: 0, failed: 0 };
          if (body.fetchMissing !== false) { try { extra = await fetchMissingAssets(r.dir, r.url, { stripScripts: body.stripScripts !== false }); } catch { /* best effort: the page still works with what the browser saved */ } }
          return json(res, 200, { ok: true, name: into || path.basename(r.dir), saved: r.saved, fetched: extra.fetched, failed: extra.failed, standalone: r.standalone && extra.fetched === 0, page: r.page });
        } catch (e) { if (made) fs.rmSync(made, { recursive: true, force: true }); throw e; }
      }
      if (u.pathname === '/api/folder') { const stopped = folderAction(body); return json(res, 200, { ok: true, stopped, folders: scan().folders }); }
      if (u.pathname === '/api/quit') { json(res, 200, { ok: true }); return setTimeout(shutdown, 150); }
      if (!safeName(body.name) || !fs.existsSync(path.join(cloneDir(body.name), META))) return json(res, 400, { error: 'unknown clone' });
      if (u.pathname === '/api/organize') { const stopped = organizeClone(body.name, body); return json(res, 200, { ok: true, stopped }); }
      if (u.pathname === '/api/start') { const r = await startClone(body.name); return json(res, 200, { port: r.port }); }
      if (u.pathname === '/api/reveal') { spawn('explorer.exe', [cloneDir(body.name)], { detached: true, stdio: 'ignore' }).unref(); return json(res, 200, { ok: true }); }
      if (u.pathname === '/api/layer') {
        const dir = cloneDir(body.name);
        if (body.action === 'download-backend') return json(res, 200, addLayerJob(body.name, 'backend'));
        if (body.action === 'capture-browser') return json(res, 200, addLayerJob(body.name, 'browser'));
        if (body.action === 'download-frontend') return json(res, 200, addLayerJob(body.name, 'frontend'));
        if (body.action === 'set-learn') { // allow/forbid fetching missing answers from the live site while this clone runs
          const m = readMeta(dir); m.learn = !!body.value; writeMeta(dir, m);
          running.get(body.name)?.setLearn(!!body.value);
          return json(res, 200, { ok: true });
        }
        if (body.action === 'delete-backend') { assertIdle(body.name); stopClone(body.name); deleteBackend(dir); return json(res, 200, { ok: true }); }
        if (body.action === 'delete-frontend') { assertIdle(body.name); stopClone(body.name); deleteFrontend(dir); return json(res, 200, { ok: true }); }
        return json(res, 400, { error: 'unknown action' });
      }
      if (u.pathname === '/api/delete') assertIdle(body.name);
      if (u.pathname === '/api/stop') { stopClone(body.name); return json(res, 200, { ok: true }); }
      if (u.pathname === '/api/delete') { stopClone(body.name); fs.rmSync(cloneDir(body.name), { recursive: true, force: true }); return json(res, 200, { ok: true }); }
    } catch (e) { return json(res, 400, { error: e.message, needsUrl: !!e.needsUrl }); }
  }
  res.writeHead(404); res.end('not found');
});

for (let i = 0; i < 50; i++, port++) {
  try {
    await new Promise((resolve, reject) => { panel.once('error', reject); panel.listen(port, '127.0.0.1', () => { panel.removeListener('error', reject); resolve(); }); });
    break;
  } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
}
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify({ port, pid: process.pid }));
armIdle(90000); // app mode: if no window ever connects, don't linger
const panelUrl = `http://localhost:${port}/`;
console.log(`\n  fibrous-cloner panel: ${panelUrl}\n  Clones folder:    ${CLONES}\n  Close this window or press Ctrl+C to stop (running clones stop too).\n`);
if (!noOpen) openBrowser(panelUrl);

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fibrous-cloner</title>
<link rel="icon" href="/icon.png"><meta name="theme-color" content="#15111a">
<style>
:root{--bg:#17181b;--side:#0f1012;--top:#1c1e21;--fg:#f1f2f4;--card:#1c1e21;--card2:#1f2124;--hover:#2a2c31;--active:#2b241d;--border:#313338;--input:#6a6d78;--muted:#9a9ca5;--muted-fg:#c6c8ce;--primary:#f08a4b;--primary-fg:#1d1209;--ring:#f08a4b;--ok:#52d094;--warn:#f0a83d;--bad:#f27878;--teal:#5fd8c8;--shadow:0 12px 32px -10px rgba(0,0,0,.7);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f4f4f6;--side:#ebebef;--top:#fff;--fg:#17181b;--card:#fff;--card2:#ececf0;--hover:#e2e2e8;--active:#f6e8dc;--border:#d6d7dd;--input:#8b8d98;--muted:#5d5f68;--muted-fg:#4a4c55;--primary:#b4500f;--primary-fg:#fff;--ring:#b4500f;--ok:#17703c;--warn:#8a5a00;--bad:#b3261e;--teal:#095f58;--shadow:0 12px 32px -12px rgba(30,30,50,.28);color-scheme:light}}
*{box-sizing:border-box}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(720px 340px at 8% -6%,color-mix(in srgb,var(--primary) 13%,transparent),transparent 70%),radial-gradient(620px 300px at 100% 112%,color-mix(in srgb,#f29bb8 8%,transparent),transparent 70%)}
::selection{background:color-mix(in srgb,var(--primary) 35%,transparent)}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13.5px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
svg.i{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
button{font:inherit;font-size:13px;font-weight:550;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--input);background:transparent;color:var(--fg);cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,color .12s}
button:hover{background:var(--hover)}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}
button.primary:hover{background:color-mix(in srgb,var(--primary) 86%,#fff)}
button.ghost{border-color:transparent;color:var(--muted-fg)}
button.ghost:hover{color:var(--fg)}
button.icon{width:32px;padding:0}
button.danger{border-color:transparent;color:var(--bad)}
button.danger:hover{background:color-mix(in srgb,var(--bad) 14%,transparent)}
button.sm{height:28px;padding:0 10px;font-size:12.5px}
button:disabled{opacity:.45;pointer-events:none}
input[type=checkbox]{appearance:none;-webkit-appearance:none;width:30px;height:18px;border-radius:99px;background:var(--input);position:relative;cursor:pointer;flex:none;margin:0;transition:background .15s}
input[type=checkbox]:before{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
input[type=checkbox]:checked{background:var(--primary)}
input[type=checkbox]:checked:before{transform:translateX(12px)}
input[type=search],select,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--input);border-radius:8px}
select{height:28px;padding:0 6px;font-size:13px}
kbd{font:11px "Cascadia Mono",ui-monospace,monospace;border:1px solid var(--input);border-bottom-width:2px;border-radius:5px;padding:0 5px;color:var(--muted-fg)}
.mono{font-family:"Cascadia Mono",ui-monospace,Consolas,monospace}
/* shell */
#app{height:100%;display:grid;grid-template-rows:auto auto 1fr;position:relative}
#app.hastray{padding-bottom:46px}
.top{display:flex;align-items:center;gap:12px;padding:12px 16px 8px}
.top img{width:30px;height:30px;border-radius:8px}
.top h1{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em;flex:1}
.top h1 small{display:block;font-size:12px;font-weight:400;color:var(--muted);letter-spacing:0}
.composer{margin:0 16px 12px;border:1px solid var(--border);border-radius:12px;background:var(--card);overflow:hidden}
.composer form{display:flex;gap:8px;padding:8px;align-items:flex-start}
.composer textarea{flex:1;min-width:0;resize:none;border:0;background:transparent;padding:7px 8px;line-height:1.5;max-height:140px;min-height:34px}
.composer textarea:focus-visible{outline:0}
.composer:focus-within{border-color:var(--ring)}
.composer .go{height:34px;padding:0 14px}
.optrow{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;padding:8px 14px;border-top:1px solid var(--border);background:var(--card2);color:var(--muted-fg);font-size:12.5px}
.optrow label{display:flex;gap:8px;align-items:center;cursor:pointer}
.optrow[hidden]{display:none}
.split{display:grid;grid-template-columns:312px 1fr;min-height:0;border-top:1px solid var(--border)}
.side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--border);background:color-mix(in srgb,var(--card) 55%,var(--bg))}
.sidehead{padding:12px 12px 8px;display:grid;gap:8px}
.search{position:relative}
.search svg{position:absolute;left:9px;top:8px;color:var(--muted)}
.search input{width:100%;height:32px;padding:0 10px 0 30px}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:2px;border-radius:9px;background:var(--card2);border:1px solid var(--border)}
.seg button{height:24px;border:0;border-radius:7px;font-size:12px;color:var(--muted-fg)}
.seg button[aria-pressed=true]{background:var(--card);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.25)}
.count{font-size:12px;color:var(--muted);padding:0 2px}
.list{flex:1;overflow:auto;padding:4px 8px 12px;display:grid;gap:2px;align-content:start}
.row{display:flex;align-items:center;gap:10px;width:100%;height:auto;padding:8px 8px;border:1px solid transparent;border-radius:9px;text-align:left;justify-content:flex-start;font-weight:400}
.row[aria-current=true]{background:color-mix(in srgb,var(--primary) 12%,var(--card));border-color:color-mix(in srgb,var(--primary) 38%,var(--border));box-shadow:inset 3px 0 0 var(--primary)}
.row .mid{flex:1;min-width:0;display:grid;line-height:1.3}
.row .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .sb{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .sb.on{color:var(--ok)}
.pills{display:flex;gap:4px;flex:none}
.pill{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:99px;font-size:10.5px;font-weight:650;border:1px solid var(--border);color:var(--muted)}
.pill:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.part:before,.pill.todo:before{border-radius:1px;transform:rotate(45deg)}.pill.miss:before{border-radius:1px}.pill.none:before,.pill.unk:before{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.pill.ok{color:var(--ok)}.pill.part,.pill.todo{color:var(--warn)}.pill.miss{color:var(--bad)}.pill.none,.pill.unk{color:var(--muted)}
.av{width:32px;height:32px;border-radius:9px;flex:none;display:grid;place-items:center;font-weight:700;font-size:14px;color:#21122e;background:var(--av,var(--primary))}
.av.lg{width:44px;height:44px;border-radius:12px;font-size:19px}
.run{position:relative}
.run:after{content:"";position:absolute;right:-2px;bottom:-2px;width:10px;height:10px;border-radius:50%;background:var(--ok);border:2px solid var(--bg)}
.detail{min-width:0;min-height:0;overflow:auto;position:relative}
.dtop{position:sticky;top:0;z-index:5;background:var(--bg)}
.dhead{display:flex;align-items:center;gap:12px;padding:14px 20px 0;flex-wrap:wrap}
.dhead .who{flex:1;min-width:160px}
.dhead .name{font-size:18px;font-weight:650;letter-spacing:-.015em;line-height:1.2;word-break:break-all}
.meta{color:var(--muted);font-size:12.5px}
.acts{display:flex;gap:6px;align-items:center}
.back{display:none}
.tabs{display:flex;gap:2px;padding:10px 20px 0;border-bottom:1px solid var(--border);overflow-x:auto}
.tabs button{height:34px;border:0;border-radius:0;border-bottom:2px solid transparent;color:var(--muted-fg);padding:0 12px;margin-bottom:-1px}
.tabs button:hover{background:transparent;color:var(--fg)}
.tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--primary)}
.tabs .n{font-size:11px;color:var(--muted);font-weight:500}
.panel{padding:18px 20px 40px;display:grid;gap:14px;max-width:820px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;display:grid;gap:10px;align-content:start}
.card h3{margin:0;font-size:12.5px;font-weight:650;display:flex;align-items:center;justify-content:space-between;gap:8px}
.card h3 .t{display:flex;gap:8px;align-items:center}
.card h3 svg{color:var(--muted)}
.big{font-size:20px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.2}
.kv{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-all}
.chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:99px;border:1px solid var(--border);color:var(--muted-fg);font-size:11.5px;font-weight:600;white-space:nowrap}
.chip:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.75}
.chip.on,.chip.done{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
.chip.q{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent);background:color-mix(in srgb,var(--warn) 10%,transparent)}
.chip.err{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
.chip.on:before{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
.info{display:flex;gap:9px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--card2);color:var(--muted-fg);font-size:12.5px}
.info svg{margin-top:2px;color:var(--muted)}
.rowline{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.switch{display:flex;gap:10px;align-items:center;cursor:pointer;color:var(--muted-fg);font-size:13px}
.sec{display:flex;align-items:center;gap:8px}
.sec b{font-size:12.5px;font-weight:650}
.sec .sp{flex:1}
.filt{height:28px;width:180px;padding:0 9px;font-size:12.5px}
details.grp{border:1px solid var(--border);border-radius:10px;background:var(--card);overflow:hidden}
details.grp summary{list-style:none;display:flex;align-items:center;gap:9px;padding:9px 12px;cursor:pointer;font-weight:600;font-size:13px}
details.grp summary::-webkit-details-marker{display:none}
details.grp summary:hover{background:var(--hover)}
details.grp summary .chev{transition:transform .15s;color:var(--muted)}
details.grp[open] summary .chev{transform:rotate(90deg)}
details.grp summary .ct{margin-left:auto;font-weight:500;color:var(--muted);font-size:12px}
details.grp ul{margin:0;padding:0;list-style:none;border-top:1px solid var(--border);max-height:260px;overflow:auto}
details.grp li{display:flex;flex-wrap:wrap;gap:2px 10px;justify-content:space-between;padding:6px 12px;font-size:12px}
details.grp li+li{border-top:1px solid var(--border)}
details.grp li code{font:11.5px "Cascadia Mono",ui-monospace,monospace;word-break:break-all}
details.grp li em{font-style:normal;color:var(--muted)}
.panel.wide{max-width:none}
.pvbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pvbar input{flex:1;min-width:140px;height:32px;padding:0 10px;font:12.5px "Cascadia Mono",ui-monospace,monospace;color:var(--muted-fg);background:var(--bg);border:1px solid var(--input);border-radius:8px}
.pvseg{width:auto}.pvseg button{padding:0 10px}
.pvstage{display:flex;justify-content:center;background:var(--card2);border:1px solid var(--border);border-radius:12px;padding:10px;overflow:auto}
.pvwrap{max-width:100%;transition:width .2s}
.pvframe{display:block;width:100%;height:calc(100vh - 380px);min-height:380px;border:1px solid var(--border);border-radius:8px;background:#fff}
.side{background:var(--side)}
.top{background:var(--top)}
button.primary{background-image:none}
.tabs button[aria-selected=true]{border-bottom-width:3px}
.lc{border-top:3px solid var(--lc);background:linear-gradient(180deg,color-mix(in srgb,var(--lc) 10%,var(--card)),var(--card) 75%)}
.lc-fe{--lc:var(--teal)}.lc-be{--lc:var(--warn)}.lc-live{--lc:var(--ok)}
.lc h3 svg{color:var(--lc)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.empty{display:grid;place-items:center;align-content:center;gap:6px;text-align:center;color:var(--muted);padding:48px 24px;height:100%}
.empty b{color:var(--fg);font-size:15px}
.empty svg{width:34px;height:34px;color:var(--primary);opacity:.8}
.bar{height:4px;border-radius:99px;background:var(--card2);overflow:hidden}
.bar i{display:block;height:100%;width:38%;background:var(--primary);border-radius:99px;animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{margin-left:-38%}100%{margin-left:100%}}
/* tray */
#tray{position:fixed;left:16px;right:16px;bottom:10px;z-index:20;border:1px solid var(--border);border-radius:12px;background:var(--card);box-shadow:var(--shadow);overflow:hidden}
#tray[hidden]{display:none}
.thead{width:100%;height:40px;border:0;border-radius:0;justify-content:flex-start;padding:0 14px;gap:10px}
.thead .sum{flex:1;text-align:left}
.thead .chev{transition:transform .15s;color:var(--muted)}
.thead[aria-expanded=true] .chev{transform:rotate(180deg)}
.tbody{max-height:42vh;overflow:auto;border-top:1px solid var(--border);display:grid}
.tbody[hidden]{display:none}
.job{display:grid;gap:6px;padding:10px 14px}
.job+.job{border-top:1px solid var(--border)}
.job .jt{display:flex;justify-content:space-between;gap:10px;align-items:center}
.job .jurl{font-weight:600;word-break:break-all}
/* floating layers */
.pop{position:fixed;z-index:50;min-width:210px;border:1px solid var(--border);border-radius:10px;background:var(--card);box-shadow:var(--shadow);padding:4px}
.pop[hidden]{display:none}
.mi{display:flex;width:100%;justify-content:flex-start;height:32px;border:0;font-weight:500;gap:10px}
.mi.danger{color:var(--bad)}
.mdiv{height:1px;background:var(--border);margin:4px -4px}
.setrow{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 10px;font-size:13px}
.shorts{padding:6px 10px 8px;display:grid;gap:5px;font-size:12px;color:var(--muted-fg);border-top:1px solid var(--border);margin-top:4px}
.shorts div{display:flex;justify-content:space-between;gap:12px}
dialog{border:1px solid var(--border);border-radius:14px;background:var(--card);color:var(--fg);padding:0;width:min(420px,calc(100vw - 32px));box-shadow:var(--shadow)}
dialog::backdrop{background:rgba(8,4,12,.6)}
dialog .db{padding:18px 18px 8px}
dialog h2{margin:0 0 6px;font-size:15px}
dialog p{margin:0;color:var(--muted-fg)}
dialog .df{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px 18px}
dialog button.confirm{background:var(--bad);border-color:var(--bad);color:#fff}
dialog button.confirm.norm{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}
#toasts{position:fixed;right:16px;bottom:64px;z-index:60;display:grid;gap:8px;max-width:min(360px,calc(100vw - 32px))}
.toast{padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--card);box-shadow:var(--shadow);font-size:13px;display:flex;gap:9px;align-items:flex-start}
.toast.err{border-color:color-mix(in srgb,var(--bad) 50%,var(--border))}
.toast.ok svg{color:var(--ok)}.toast.err svg{color:var(--bad)}
@media (prefers-reduced-motion:no-preference){.toast{animation:tin .2s ease both}@keyframes tin{from{opacity:0;transform:translateY(8px)}}}
@media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%;opacity:.5}.chip.on:before{animation:none}}
@media (max-width:759px){
  .split{grid-template-columns:1fr}
  #app[data-view=list] .detail{display:none}
  #app[data-view=detail] .side{display:none}
  .back{display:inline-flex}
  button{min-height:44px}.row{min-height:52px}.seg button,button.sm,.tabs button{min-height:40px}
  .grid2{grid-template-columns:1fr}
  .kv{grid-template-columns:100px 1fr}
  .dhead,.tabs,.panel{padding-left:14px;padding-right:14px}
  .composer,#tray{margin-left:10px;margin-right:10px}#tray{left:0;right:0}
  .top{padding-left:10px;padding-right:10px}
  .top h1 small{display:none}
  .composer form{flex-wrap:wrap}.composer textarea{flex:1 1 100%}.composer .go{flex:1}#optbtn{margin-top:0!important}
  .filt{width:100%}
}
/* ---- Panel skin: neutral near-black, flat, indigo accent, nav-style list, pill tabs ---- */
body{font-family:Inter,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
body:before{content:none}
#app{grid-template-rows:auto 1fr}
.top{background:var(--top);border-bottom:1px solid var(--border);height:48px;padding:0 14px;margin:0;gap:10px}
.top img{width:24px;height:24px;border-radius:6px}
.top h1{display:flex;align-items:baseline;gap:10px;font-size:14px;white-space:nowrap;overflow:hidden;letter-spacing:0}
.top h1 small{display:inline;font-size:12px;font-weight:400;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
.split{grid-template-columns:288px 1fr;border-top:0}
.side{background:var(--side);border-right:1px solid var(--border)}
.navlabel{padding:14px 18px 6px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.rightcol{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--bg)}
.composer{margin:14px 20px 8px;border-radius:10px;box-shadow:none;background:var(--card)}
.detail{flex:1}
.list{padding:2px 10px 12px}
.row{border-radius:8px;padding:7px 8px}
.row[aria-current=true]{background:var(--active);border-color:transparent;box-shadow:none}
.row[aria-current=true] .nm{color:var(--primary)}
.seg{background:var(--card2);border-color:var(--border)}
.seg button[aria-pressed=true]{background:var(--hover);box-shadow:none}
.dtop{background:var(--bg)}
.tabs{display:inline-flex;margin:12px 20px 0;padding:4px;gap:2px;border:1px solid var(--border);border-radius:10px;background:var(--card2);max-width:calc(100% - 40px)}
.tabs button{height:30px;margin:0;border:0;border-radius:7px;padding:0 14px}
.tabs button:hover{background:var(--hover);color:var(--fg)}
.tabs button[aria-selected=true]{background:var(--hover);color:var(--fg);font-weight:650;border-bottom-width:0}
.card{border-radius:10px;box-shadow:none}
.lc{border-top:1px solid var(--border);background:var(--card)}
.lc h3 svg{color:var(--muted)}
.av{background:color-mix(in srgb,var(--av,var(--primary)) 18%,var(--card));color:var(--av,var(--primary));border-radius:8px}
@media (prefers-color-scheme:light){.av{background:color-mix(in srgb,var(--av,var(--primary)) 40%,var(--card));color:var(--fg)}}
.run:after{border-color:var(--side)}
.info{background:color-mix(in srgb,var(--warn) 9%,var(--card));border-color:color-mix(in srgb,var(--warn) 30%,var(--card));color:var(--warn)}.info svg{color:var(--warn)}
button.primary{background:var(--primary);background-image:none;color:var(--primary-fg);border-color:var(--primary)}
button.primary:hover{background:color-mix(in srgb,var(--primary) 88%,#fff)}
.chip.on:before{box-shadow:none}
@media (max-width:759px){.split{grid-template-columns:1fr}.rightcol{order:-1}.side{order:2}.composer{margin:10px}.tabs{margin:10px 14px 0}}
/* ---- folders and tags ---- */
.navlabel{display:flex;align-items:center;justify-content:space-between;padding:14px 10px 6px 18px}
.navlabel button{width:26px;height:26px;padding:0}
.tagbar{display:flex;flex-wrap:wrap;gap:4px}
.tagbar button{height:22px;padding:0 8px;font-size:11.5px;font-weight:550;border-radius:99px;color:var(--muted-fg);border-color:var(--border)}
.tagbar button[aria-pressed=true]{background:var(--active);color:var(--primary);border-color:color-mix(in srgb,var(--primary) 45%,var(--border))}
.tagbar button.clear{border-color:transparent;color:var(--muted)}
.fh{display:flex;align-items:center;gap:2px;margin:8px 0 2px;border-radius:8px;color:var(--muted)}
.fh.edit,.fh:has(.fin){padding-left:8px;gap:6px}
.fhb{flex:1;min-width:0;justify-content:flex-start;height:28px;border:0;padding:0 6px;gap:6px;font-size:11.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.fhb svg{width:14px;height:14px}
.fhb .fnm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fhb .ct{margin-left:auto;font-weight:500;letter-spacing:0}
.fh .fa{width:24px;height:24px;padding:0;opacity:0}
.fh:hover .fa,.fh:focus-within .fa{opacity:1}
.fh.drop{background:var(--active);outline:1px dashed var(--primary)}
.fin{flex:1;min-width:0;height:28px;padding:0 8px;font:inherit;font-size:13px;color:var(--fg);background:var(--bg);border:1px solid var(--input);border-radius:7px}
.grp{padding-left:6px;margin-left:8px;border-left:1px solid var(--border)}
.row[draggable=true]{cursor:grab}
.tg{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tagrow{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
.tagchip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:99px;font-size:11.5px;font-weight:550;color:var(--muted-fg);background:var(--card2);border:1px solid var(--border)}
.tagchip svg{width:12px;height:12px}
.tagchip button{height:18px;width:18px;padding:0;border:0;border-radius:50%;margin-right:-4px;color:var(--muted)}
.tagchip.fchip{color:var(--primary);background:var(--active);border-color:transparent}
.org{gap:12px}
.orgrow{display:grid;grid-template-columns:84px 1fr;gap:10px;align-items:center}
.org select{height:32px;width:100%;max-width:260px;font-size:13px;padding:0 8px}
.tagedit{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:5px 6px;border:1px solid var(--input);border-radius:8px;background:var(--bg);min-height:36px}
.tagedit:focus-within{outline:2px solid var(--ring);outline-offset:2px}
.tin{flex:1;min-width:120px;height:26px;border:0;background:transparent;color:var(--fg);font:inherit;font-size:13px;padding:0 4px}
.tin:focus-visible{outline:0}
.sugs{display:flex;gap:6px;flex-wrap:wrap}
.sug{height:24px;padding:0 9px;font-size:12px;border-radius:99px;color:var(--muted-fg);border-style:dashed}
@media (max-width:759px){.orgrow{grid-template-columns:1fr}.fh .fa{opacity:1}}
.fh{margin-left:calc(var(--d,0)*14px)}
.row{margin-left:calc(var(--d,0)*14px);width:calc(100% - var(--d,0)*14px)}
.fh[draggable=true]{cursor:grab}
.navlabel.drop,#list.drop{background:var(--active);outline:1px dashed var(--primary);outline-offset:-2px}
.grp{padding-left:0;margin-left:0;border-left:0}
.notice{display:flex;gap:10px;align-items:flex-start;margin:0 20px 8px;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--warn) 30%,var(--card));background:color-mix(in srgb,var(--warn) 9%,var(--card));font-size:13px}
.notice[hidden]{display:none}
.notice>svg{color:var(--warn);margin-top:2px}
.ntext{flex:1;min-width:0;color:var(--fg)}.ntext b{color:var(--warn);font-weight:650}
.nbtns{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:46%}
#impdlg{width:min(540px,calc(100vw - 32px))}
.impsteps{margin:8px 0 12px;padding-left:20px;color:var(--muted-fg);font-size:13px;display:grid;gap:3px}
.improw{display:flex;gap:8px;flex-wrap:wrap}
.imppath{margin:8px 0;word-break:break-all}
.imp2{display:grid;grid-template-columns:96px 1fr;gap:10px;align-items:center;margin:8px 0}
.imp2 input[type=text],.imp2 select{width:100%;height:32px;padding:0 10px;font:inherit;font-size:13px;color:var(--fg);background:var(--bg);border:1px solid var(--input);border-radius:8px}
.optrow2{display:flex;gap:9px;align-items:center;margin:10px 0;font-size:13px;color:var(--muted-fg);cursor:pointer}
@media (max-width:759px){.notice{margin:0 10px 8px;flex-wrap:wrap}.nbtns{max-width:none;justify-content:flex-start}.imp2{grid-template-columns:1fr}}
/* ---- glow-up polish: depth, rhythm, focus, motion (no layout changes) ---- */
:root{--r:12px;--ease:cubic-bezier(.2,.7,.2,1)}
.card{border-radius:var(--r);transition:border-color .18s var(--ease)}
.card:hover{border-color:color-mix(in srgb,var(--primary) 35%,var(--border))}
button:active{transform:translateY(1px)}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:8px}
.tabs button{transition:background .15s var(--ease),color .15s var(--ease)}
.org{opacity:.92}
.org h3,.org .ttl{font-size:12.5px;letter-spacing:.02em}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.empty{animation:rise .4s var(--ease) both}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted) 35%,transparent);border-radius:10px;border:2px solid transparent;background-clip:content-box}::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb,var(--muted) 60%,transparent)}
::selection{background:color-mix(in srgb,var(--primary) 40%,transparent)}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
.split{grid-template-columns:var(--sidew,336px) 1fr}
.side{position:relative}
.rz{position:absolute;top:0;right:-4px;width:9px;height:100%;cursor:col-resize;z-index:20;touch-action:none}
.rz:after{content:"";position:absolute;left:4px;top:0;width:1px;height:100%;background:transparent;transition:background .15s,width .15s,left .15s}
.rz:hover:after,.rz.on:after,.rz:focus-visible:after{background:var(--primary);width:3px;left:3px}
body.rzing{cursor:col-resize;user-select:none}body.rzing iframe{pointer-events:none}
@media (max-width:759px){.split{grid-template-columns:1fr}.rz{display:none}}

/* Local library workspace. */
body:before{display:none}body{font-size:14px;font-variant-numeric:tabular-nums}
.top{padding:16px 24px}.top h1{letter-spacing:-.03em}.top h1 small{letter-spacing:0}
.sidehead{padding:18px 14px 12px;gap:12px}.search input{height:38px}.search svg{top:11px}
.library-tools{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted-fg)}.library-tools select{flex:1;min-width:0;border-color:var(--border)}
.fh,.fhb{min-width:0}.fnm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row{padding:10px 8px;min-height:58px}.row .nm{font-size:13px}.row .sb{font-size:11px}
.fh,.row{--indent:min(calc(var(--d,0)*10px),40px);margin-left:var(--indent)}.row{width:calc(100% - var(--indent))}.list{overflow-x:hidden}
.composer{margin:20px 24px 16px}.composer-label{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px 0;font-size:12px}.composer-label span{color:var(--muted)}.composer form{padding:10px;align-items:center}.composer textarea{min-height:40px}.composer .go{height:40px}
.dhead{padding:12px 28px 18px;gap:14px}.dhead .name{font-size:26px;letter-spacing:-.035em}.tabs{padding:0 28px;gap:12px}.tabs button{height:44px;padding:0 4px}
.panel{max-width:1200px;padding:24px 28px 48px;gap:18px}.card{padding:20px}.card h3{font-size:13px}.big{font-size:30px}.grid2{gap:18px}.org{opacity:1}.kv{grid-template-columns:140px minmax(0,1fr)}
@media(min-width:1400px){.panel.overview{grid-template-columns:minmax(0,1.4fr) minmax(280px,1fr)}.overview>.grid2{grid-column:1/-1}.overview>.card{align-self:start}}
@media(max-width:950px){.composer-label span{display:none}.dhead{padding:12px 18px}.panel{padding:18px}.composer{margin:12px}.top h1 small{display:none}}
@media(max-width:759px){.composer form{flex-wrap:wrap}.composer textarea{flex-basis:100%}.composer .go{margin-left:auto}.dhead .name{font-size:22px}.grid2{grid-template-columns:1fr}.tabs{padding:0 16px;gap:8px}}

</style></head>
<body>
<div id="app" data-view="list">
  <header class="top">
    <img src="/icon.png" alt="" width="30" height="30">
    <h1>fibrous-cloner<small>Your local website library</small></h1>
    <button id="gear" class="ghost icon" type="button" aria-label="Settings" aria-haspopup="true" aria-expanded="false" title="Settings"></button>
    <button id="quit" class="ghost sm" type="button" title="Stop fibrous-cloner and every running copy"></button>
  </header>

  <div class="split">
    <aside class="side" aria-label="Clones"><div class="rz" id="rz" role="separator" aria-orientation="vertical" aria-label="Resize clone list" tabindex="0" title="Drag to resize (double-click to reset)"></div>
      <div class="sidehead">
        <div class="search"><span id="sico"></span><input id="q" type="search" placeholder="Search clones" aria-label="Search clones" autocomplete="off"></div>
        <div class="seg" id="seg" role="group" aria-label="Filter clones">
          <button type="button" data-f="all" aria-pressed="true">All</button>
          <button type="button" data-f="running" aria-pressed="false">Running</button>
          <button type="button" data-f="needs" aria-pressed="false">Needs data</button>
        </div>
        <div class="library-tools"><label for="sort">Sort</label><select id="sort"><option value="name">Name A-Z</option><option value="recent">Newest first</option><option value="size">Largest first</option></select><button type="button" id="foldall" class="ghost sm">Collapse folders</button></div><div class="count" id="count" role="status"></div>
        <div class="tagbar" id="tagbar" hidden></div>
      </div>
      <div class="navlabel"><span>Clones</span><button type="button" id="newfolder" class="ghost icon sm" aria-label="New folder" title="New folder"></button></div>
      <div class="list" id="list" role="list"></div>
    </aside>
    <div class="rightcol">
  <section class="composer" aria-label="Clone a site">
    <div class="composer-label"><b>Add a website</b><span>Enter to queue / Shift + Enter for another URL</span></div><form id="f">
      <textarea id="url" rows="1" autocomplete="off" spellcheck="false" placeholder="Paste one or more site URLs, one per line" aria-label="Website URLs" required autofocus></textarea>
      <button id="impbtn" class="ghost sm" type="button" title="Import a page you saved from your browser with Ctrl+S" style="margin-top:3px"></button>
      <button id="optbtn" class="ghost sm" type="button" aria-expanded="false" aria-controls="optrow" style="margin-top:3px"></button>
      <button class="primary go" id="go" type="submit"></button>
    </form>
    <div class="optrow" id="optrow" hidden>
      <label><input type="checkbox" id="auto" checked> Start localhost when done</label>
      <label title="Saves what the site's public API answers to a visitor so the localhost copy shows real-looking data. Never uses logins or cookies."><input type="checkbox" id="api" checked> Save backend data (public API answers)</label>
    </div>
  </section>
    <div id="notice" class="notice" role="status" hidden></div>
    <main class="detail" id="detail"></main>
    </div>
  </div>

  <section id="tray" hidden aria-label="Copy queue">
    <button class="thead" id="thead" type="button" aria-expanded="false"><span class="sum" id="tsum"></span><span id="tchev"></span></button>
    <div class="tbody" id="queue" hidden></div>
  </section>
</div>

<dialog id="impdlg" aria-labelledby="imptitle"><div class="db">
  <h2 id="imptitle">Import a saved page</h2>
  <p class="meta">For sites that only show their content to a real browser (bot protection, or pages a script can't fetch). Let your own browser load the page, then save it:</p>
  <ol class="impsteps"><li>Open the site in your normal browser and wait until it has fully loaded.</li><li>Press <kbd>Ctrl</kbd>+<kbd>S</kbd> and choose <b>Webpage, Complete</b> (or Single File).</li><li>Pick the saved file below, or let fibrous-cloner watch your Downloads folder.</li></ol>
  <div class="improw"><button type="button" id="impbrowse" class="sm"></button><button type="button" id="impwatch" class="sm"></button></div>
  <p class="meta imppath" id="imppath">No file chosen</p>
  <label class="imp2"><span class="meta">Site address</span><input type="text" id="impurl" placeholder="https://example.com/" autocomplete="off" spellcheck="false"></label>
  <label class="imp2"><span class="meta">Save to</span><select id="impinto" aria-label="Save to"></select></label>
  <label class="optrow2"><input type="checkbox" id="impstrip" checked> Remove scripts (a static HTML/CSS copy, the most reliable)</label>
  <label class="optrow2"><input type="checkbox" id="impfetch" checked> Also download the fonts, images and stylesheets the page uses but your browser did not save, so it works offline</label>
  <p class="meta" id="impmsg" role="status"></p>
</div><div class="df"><button type="button" id="impcancel">Cancel</button><button type="button" id="impgo" class="primary" disabled>Import</button></div></dialog>
<div class="pop" id="menu" role="menu" hidden></div>
<div class="pop" id="settings" hidden>
  <div class="setrow"><span>Copy sites at once</span><select id="par" aria-label="Sites copied at the same time"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option><option>6</option><option>8</option><option>10</option><option>12</option></select></div>
  <div class="shorts">
    <div><span>Search clones</span><kbd>/</kbd></div>
    <div><span>Focus the URL box</span><kbd>n</kbd></div>
    <div><span>Add to queue</span><span><kbd>Ctrl</kbd> <kbd>Enter</kbd></span></div>
    <div><span>Close menus</span><kbd>Esc</kbd></div>
  </div>
</div>
<dialog id="dlg"><div class="db"><h2 id="dt"></h2><p id="dp"></p></div><div class="df"><button type="button" id="dno">Cancel</button><button type="button" id="dyes" class="confirm"></button></div></dialog>
<div id="toasts" role="status" aria-live="polite"></div>

<script>
const H={'Content-Type':'application/json','X-Fibrous-Sites':'1'};
const post=(p,b)=>fetch(p,{method:'POST',headers:H,body:JSON.stringify(b)}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error||'failed');return j});
const $=s=>document.querySelector(s);
const ls=k=>{try{return localStorage.getItem(k)}catch{return null}};
const sls=(k,v)=>{try{localStorage.setItem(k,v)}catch{}};
const h=(t,p={},...k)=>{const e=document.createElement(t);for(const[a,v]of Object.entries(p)){if(v==null||v===false)continue;if(a==='class')e.className=v;else if(a.startsWith('on'))e.addEventListener(a.slice(2),v);else if(a in e&&!a.includes('-')&&a!=='role'&&a!=='list')e[a]=v;else e.setAttribute(a,v===true?'':v)}for(const x of k.flat(Infinity))if(x!=null&&x!==false)e.append(x);return e};
const IC={info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',folderplus:'<path d="M12 10v6M9 13h6M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',tag:'<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z"/><circle cx="7.5" cy="7.5" r=".5"/>',pencil:'<path d="M12 20h9M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',play:'<polygon points="6 4 20 12 6 20 6 4"/>',stop:'<rect x="5" y="5" width="14" height="14" rx="2"/>',ext:'<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',folder:'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',trash:'<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',dl:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',refresh:'<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',globe:'<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',db:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>',x:'<path d="M18 6 6 18M6 6l12 12"/>',chev:'<path d="m9 18 6-6-6-6"/>',down:'<path d="m6 9 6 6 6-6"/>',up:'<path d="m18 15-6-6-6 6"/>',search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',more:'<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',back:'<path d="m15 18-6-6 6-6"/>',plus:'<path d="M12 5v14M5 12h14"/>',power:'<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',check:'<path d="M20 6 9 17l-5-5"/>',sliders:'<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',layers:'<path d="m12 2 10 5-10 5L2 7l10-5ZM2 17l10 5 10-5M2 12l10 5 10-5"/>'};
const icon=n=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('class','i');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('aria-hidden','true');s.innerHTML=IC[n]||'';return s};
const btn=(cls,ic,label,props={})=>h('button',Object.assign({type:'button',class:cls},props),ic?icon(ic):null,label);
const AVC=['#c996f7','#f29bb8','#f0b86a','#5fd3c4','#7db4f5','#b9d96c']; // one harmonised colour per clone so rows are easy to tell apart
const avStyle=n=>{let x=0;for(const ch of n)x=(x*31+ch.charCodeAt(0))>>>0;return '--av:'+AVC[x%AVC.length]};
const fmtB=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
const plural=(n,w)=>n+' '+w+(n===1?'':'s');
const fmtD=d=>d?new Date(d).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'';

// static icons
$('#gear').append(icon('gear'));$('#quit').append(icon('power'),'Quit');$('#go').append(icon('plus'),'Add to queue');
$('#optbtn').append(icon('sliders'),'Options');$('#sico').append(icon('search'));$('#tchev').append(icon('up'));

const S={notices:[],pvw:ls('sc.pvw')||'full',items:[],jobs:[],sel:ls('sc.sel'),tab:ls('sc.tab')||'overview',filter:'all',q:'',busy:new Set(),parallel:3,folders:[],tagFilter:new Set(),editing:null,collapsed:(()=>{try{return new Set(JSON.parse(ls('sc.collapsed')||'[]'))}catch{return new Set()}})()};
const openG=new Set(),epFilter={};
let lastSig='';

// ---------- toast + dialog ----------
function toast(msg,kind='ok'){
  const t=h('div',{class:'toast '+kind},icon(kind==='err'?'x':'check'),h('span',{},msg));
  $('#toasts').append(t);setTimeout(()=>t.remove(),kind==='err'?6000:3800);
}
let dlgDone=null;
function ask(title,body,label,opts={}){
  return new Promise(res=>{
    const d=$('#dlg');$('#dt').textContent=title;$('#dp').textContent=body;
    const y=$('#dyes');y.textContent=label;y.className='confirm'+(opts.normal?' norm':'');
    const done=v=>{dlgDone=null;if(d.open)d.close();res(v)};dlgDone=done;
    y.onclick=()=>done(true);$('#dno').onclick=()=>done(false);d.oncancel=e=>{e.preventDefault();done(false)};
    d.showModal();$('#dno').focus();
  });
}

// ---------- status helpers ----------
const feState=c=>c.frontend.files>0?'ok':'miss';
function beState(c){const be=c.backend;if(be)return be.captured?(be.missing.length||be.gated.length?'part':'ok'):'none';return c.endpointsKnown>0?'todo':(c.endpointsChecked?'none':'unk')}
const FE_LBL={ok:'Saved',miss:'Missing'};
const BE_LBL={ok:'Saved',part:'Partial',none:'Nothing public',todo:'Not downloaded',unk:'Not checked'};
const chipCls=s=>s==='ok'?'done':(s==='miss'?'err':(s==='none'?'':'q'));
const sel=()=>S.items.find(c=>c.name===S.sel)||null;

// ---------- actions ----------
async function layer(name,action,cf){
  if(cf&&!(await ask(cf[0],cf[1],cf[2])))return;
  try{await post('/api/layer',{name,action});toast(action.startsWith('delete')?'Deleted.':'Started. Progress is in the queue below.')}catch(e){toast(e.message,'err')}
  lastSig='';pollJobs();loadClones();
}
async function simple(path,name,ok){try{await post(path,{name});if(ok)toast(ok)}catch(e){toast(e.message,'err')}lastSig='';loadClones()}
async function startAndOpen(name){
  const w=window.open('','_blank');
  try{const r=await post('/api/start',{name});const u='http://localhost:'+r.port+'/';if(w)w.location=u;else window.open(u,'_blank')}
  catch(e){if(w)w.close();toast(e.message,'err')}
  lastSig='';loadClones();
}
const delClone=c=>ask('Delete '+c.name+'?','This removes the whole copy, frontend and backend data, and cannot be undone.','Delete clone').then(async ok=>{if(ok){await simple('/api/delete',c.name,'Deleted '+c.name);}});
const delFe=c=>layer(c.name,'delete-frontend',['Delete the website files?','The saved backend data of '+c.name+' is kept and you can download the frontend again any time.'+(c.running?' This also stops its localhost server.':''),'Delete frontend']);
const delBe=c=>layer(c.name,'delete-backend',['Delete the saved backend data?','The website files of '+c.name+' are kept. You can download the data again later.'+(c.running?' This also stops its localhost server.':''),'Delete backend data']);

// ---------- floating menu / settings ----------
const menu=$('#menu'),setPop=$('#settings');let menuTrig=null;
function closePops(ret){menu.hidden=true;setPop.hidden=true;$('#gear').setAttribute('aria-expanded','false');if(ret&&menuTrig&&document.contains(menuTrig))menuTrig.focus();menuTrig=null}
function placePop(pop,trig){const r=trig.getBoundingClientRect();pop.hidden=false;const w=pop.offsetWidth;pop.style.top=Math.min(r.bottom+6,innerHeight-pop.offsetHeight-8)+'px';pop.style.left=Math.max(8,Math.min(r.right-w,innerWidth-w-8))+'px'}
function openMenu(trig,c){
  if(!menu.hidden){closePops(true);return}
  closePops();menuTrig=trig;menu.replaceChildren();
  const busy=S.busy.has(c.name),hasFe=c.frontend.files>0;
  const items=[['folder','Open folder',()=>simple('/api/reveal',c.name)],
    ['upload','Replace with a saved page…',()=>openImport({url:c.origin?c.origin+'/':'',into:c.name,repair:true})],
    [hasFe?'refresh':'dl',hasFe?'Re-download frontend':'Download frontend',()=>layer(c.name,'download-frontend'),busy],
    [c.backend?'refresh':'dl',c.backend?'Refresh backend data':'Download backend data',()=>layer(c.name,'download-backend'),busy],
    'div',
    ['trash','Delete frontend',()=>delFe(c),busy||!hasFe,1],
    ['trash','Delete backend data',()=>delBe(c),busy||!c.backend,1],
    ['trash','Delete clone',()=>delClone(c),false,1]];
  for(const it of items){
    if(it==='div'){menu.append(h('div',{class:'mdiv',role:'separator'}));continue}
    menu.append(h('button',{type:'button',class:'mi'+(it[4]?' danger':''),role:'menuitem',disabled:!!it[3],onclick:()=>{closePops(false);it[2]()}},icon(it[0]),it[1]));
  }
  trig.setAttribute('aria-expanded','true');placePop(menu,trig);menu.querySelector('.mi:not(:disabled)').focus();
}
menu.addEventListener('keydown',e=>{
  const its=[...menu.querySelectorAll('.mi:not(:disabled)')],i=its.indexOf(document.activeElement);
  if(e.key==='ArrowDown'){e.preventDefault();its[(i+1)%its.length].focus()}
  else if(e.key==='ArrowUp'){e.preventDefault();its[(i-1+its.length)%its.length].focus()}
  else if(e.key==='Home'){e.preventDefault();its[0].focus()}else if(e.key==='End'){e.preventDefault();its[its.length-1].focus()}
  else if(e.key==='Tab'){closePops(true)}
});
$('#gear').addEventListener('click',()=>{if(!setPop.hidden){closePops(false);return}closePops();$('#gear').setAttribute('aria-expanded','true');placePop(setPop,$('#gear'))});
document.addEventListener('mousedown',e=>{if(menu.hidden&&setPop.hidden)return;if(menu.contains(e.target)||setPop.contains(e.target)||e.target.closest('#gear')||(menuTrig&&menuTrig.contains(e.target)))return;closePops(false)});
addEventListener('resize',()=>closePops(false));

// ---------- sidebar ----------
const pill=(l,s)=>h('span',{class:'pill '+s,title:l+': '+({ok:'saved',part:'partial',miss:'missing',todo:'not downloaded',none:'none',unk:'not checked'})[s]},l);
const folderOf=c=>c.folder||'';
const segs=p=>p.split('/'),leaf=p=>segs(p).pop(),parentOf=p=>segs(p).slice(0,-1).join('/');
const nice=p=>p.replace(/\//g,' / ');
const inTree=(c,p)=>folderOf(c)===p||folderOf(c).startsWith(p+'/');
const hasTag=(c,t)=>(c.tags||[]).some(x=>x.toLowerCase()===t.toLowerCase());
function allTags(){const m=new Map();for(const c of S.items)for(const t of c.tags||[]){const k=t.toLowerCase(),e=m.get(k)||{tag:t,n:0};e.n++;m.set(k,e)}return [...m.values()].sort((a,b)=>b.n-a.n||a.tag.localeCompare(b.tag))}
function visible(){
  const q=S.q.trim().toLowerCase();
  return S.items.filter(c=>{
    if(q&&!(c.name.toLowerCase().includes(q)||(c.origin||'').toLowerCase().includes(q)||folderOf(c).toLowerCase().includes(q)||(c.tags||[]).some(t=>t.toLowerCase().includes(q))))return false;
    for(const t of S.tagFilter)if(!hasTag(c,t))return false;
    if(S.filter==='running')return !!c.running;
    if(S.filter==='needs'){const b=beState(c);return feState(c)==='miss'||b==='todo'||b==='unk'}
    return true;
  });
}
function renameKeys(from,to){const next=new Set();for(const k of S.collapsed)next.add(k===from||k.startsWith(from+'/')?to+k.slice(from.length):k);S.collapsed=next;sls('sc.collapsed',JSON.stringify([...next]))}
async function organize(name,patch,refocus){
  try{const r=await post('/api/organize',{name,...patch});if('folder' in patch)toast('Moved'+(r.stopped?'. Its localhost server was stopped so the files could move':''))}
  catch(e){toast(e.message,'err')}
  if(refocus)S.refocusTag=true;lastSig='';await loadClones();
}
async function folderOp(body,ok){
  try{const r=await post('/api/folder',body);if(ok)toast(ok+(r.stopped?'. A running clone was stopped so the files could move':''))}
  catch(e){toast(e.message,'err');return false}
  lastSig='';await loadClones();return true;
}
const delFolder=p=>{const n=S.items.filter(c=>inTree(c,p)).length;return ask('Delete the folder "'+leaf(p)+'"?',(n?(n===1?'Its site stays':'Its '+n+' sites stay'):'The folder is empty')+(n?' and moves up one level':'')+'. No site is deleted.','Delete folder').then(ok=>{if(ok)folderOp({action:'delete',path:p},'Folder deleted')})};
function dropOn(target,e){
  const d=e.dataTransfer.getData('text/plain')||'';
  if(d.startsWith('clone:'))organize(d.slice(6),{folder:target});
  else if(d.startsWith('folder:')){const from=d.slice(7);if(from!==target&&parentOf(from)!==target)folderOp({action:'move',path:from,parent:target},'Moved')}
}
function dropTarget(el,target){
  el.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();el.classList.add('drop')});
  el.addEventListener('dragleave',()=>el.classList.remove('drop'));
  el.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();el.classList.remove('drop');dropOn(target,e)});
}
function renderTagbar(){
  const bar=$('#tagbar'),tags=allTags();bar.replaceChildren();bar.hidden=!tags.length;
  for(const {tag,n} of tags.slice(0,14)){
    const on=[...S.tagFilter].some(x=>x.toLowerCase()===tag.toLowerCase());
    bar.append(h('button',{type:'button','aria-pressed':String(on),title:plural(n,'clone'),onclick:()=>{const k=[...S.tagFilter].find(x=>x.toLowerCase()===tag.toLowerCase());k?S.tagFilter.delete(k):S.tagFilter.add(tag);renderList()}},'#'+tag));
  }
  if(S.tagFilter.size)bar.append(h('button',{type:'button',class:'clear',onclick:()=>{S.tagFilter.clear();renderList()}},'Clear'));
}
function editInput(depth){
  const ed=S.editing;
  const inp=h('input',{type:'text',class:'fin',maxLength:40,placeholder:'Folder name','aria-label':ed.kind==='new'?'New folder name':'Rename folder',value:ed.text||''});
  inp.addEventListener('input',()=>{ed.text=inp.value});
  inp.addEventListener('keydown',async e=>{
    if(e.key==='Escape'){e.preventDefault();S.editing=null;renderList();return}
    if(e.key!=='Enter')return;e.preventDefault();
    const v=inp.value.trim();if(!v){S.editing=null;renderList();return}
    let ok;
    if(ed.kind==='new'){ok=await folderOp({action:'create',parent:ed.parent||'',name:v},'Folder created');if(ok&&ed.parent){S.collapsed.delete(ed.parent);sls('sc.collapsed',JSON.stringify([...S.collapsed]))}}
    else{ok=await folderOp({action:'rename',path:ed.name,to:v},'Renamed');if(ok){const par=parentOf(ed.name);renameKeys(ed.name,par?par+'/'+v:v)}}
    if(ok)S.editing=null;renderList();
  });
  inp.addEventListener('blur',()=>setTimeout(()=>{if(inp.isConnected&&S.editing===ed&&document.activeElement!==inp){S.editing=null;renderList()}},150));
  S.focusEdit=true;return inp;
}
function folderHead(p,depth){
  const collapsed=S.collapsed.has(p),head=h('div',{class:'fh',draggable:true,style:'--d:'+depth,ondragstart:e=>{e.dataTransfer.setData('text/plain','folder:'+p);e.dataTransfer.effectAllowed='move'}});
  if(S.editing&&S.editing.kind==='rename'&&S.editing.name===p){head.append(icon('folder'),editInput());return head}
  head.append(h('button',{type:'button',class:'fhb','aria-expanded':String(!collapsed),onclick:()=>{collapsed?S.collapsed.delete(p):S.collapsed.add(p);sls('sc.collapsed',JSON.stringify([...S.collapsed]));renderList()}},icon(collapsed?'chev':'down'),icon('folder'),h('span',{class:'fnm'},leaf(p)),h('span',{class:'ct'},String(S.items.filter(c=>inTree(c,p)).length))));
  if(depth<3)head.append(btn('sm ghost icon fa','folderplus','',{'aria-label':'New folder inside '+leaf(p),title:'New folder inside',onclick:()=>{S.editing={kind:'new',parent:p,text:''};S.collapsed.delete(p);renderList()}}));
  head.append(btn('sm ghost icon fa','pencil','',{'aria-label':'Rename folder '+leaf(p),title:'Rename',onclick:()=>{S.editing={kind:'rename',name:p,text:leaf(p)};renderList()}}),btn('sm ghost icon fa','trash','',{'aria-label':'Delete folder '+leaf(p),title:'Delete folder',onclick:()=>delFolder(p)}));
  dropTarget(head,p);
  return head;
}
function cloneRow(c,depth){
  const sub=c.running?'Running · :'+c.running.port:(c.frontend.files?fmtB(c.frontend.bytes):'No frontend');
  return h('button',{type:'button',class:'row',role:'listitem',draggable:true,style:'--d:'+depth,'data-name':c.name,'aria-current':String(c.name===S.sel),onclick:()=>select(c.name,true),ondragstart:e=>{e.dataTransfer.setData('text/plain','clone:'+c.name);e.dataTransfer.effectAllowed='move'}},
    h('div',{class:'av'+(c.running?' run':''),style:avStyle(c.name),'aria-hidden':'true'},(c.name[0]||'?').toUpperCase()),
    h('div',{class:'mid'},h('span',{class:'nm'},c.name),h('span',{class:'sb'+(c.running?' on':'')},sub),(c.tags||[]).length?h('span',{class:'tg'},c.tags.slice(0,3).map(t=>'#'+t).join('  ')):null),
    h('span',{class:'pills'},pill('FE',feState(c)),pill('BE',beState(c))));
}
function renderList(){
  const list=$('#list'),act=document.activeElement,keep=act&&act.dataset&&act.dataset.name&&list.contains(act)?act.dataset.name:null,st=list.scrollTop;
  $('#foldall').textContent=S.folders.some(f=>!S.collapsed.has(f))?'Collapse':'Expand';
  const order=$('#sort').value;
  const v=visible().sort((a,b)=>order==='size'?(b.frontend.bytes||0)-(a.frontend.bytes||0):order==='recent'?(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0):a.name.localeCompare(b.name));list.replaceChildren();renderTagbar();
  $('#count').textContent=S.items.length?(v.length===S.items.length?plural(S.items.length,'clone'):v.length+' of '+S.items.length)+' · '+S.items.filter(c=>c.running).length+' running':'';
  const filtering=!!(S.q.trim()||S.filter!=='all'||S.tagFilter.size);
  const has=p=>v.some(c=>inTree(c,p));
  if(S.editing&&S.editing.kind==='new'&&!S.editing.parent)list.append(h('div',{class:'fh edit',style:'--d:0'},icon('folder'),editInput()));
  const emit=(p,depth)=>{
    if(filtering&&!has(p))return;
    list.append(folderHead(p,depth));
    if(S.collapsed.has(p))return;
    if(S.editing&&S.editing.kind==='new'&&S.editing.parent===p)list.append(h('div',{class:'fh edit',style:'--d:'+(depth+1)},icon('folder'),editInput()));
    for(const f of S.folders.filter(x=>parentOf(x)===p))emit(f,depth+1);
    for(const c of v.filter(c=>folderOf(c)===p))list.append(cloneRow(c,depth+1));
  };
  for(const f of S.folders.filter(x=>!parentOf(x)))emit(f,0);
  const rootClones=v.filter(c=>!folderOf(c));
  for(const c of rootClones)list.append(cloneRow(c,0));
  if(!v.length&&!S.folders.length&&!(S.editing&&!S.editing.parent))list.append(h('div',{class:'empty',style:'padding:28px 12px;height:auto'},S.items.length?h('span',{},'No clones match.'):h('span',{},'No clones yet.')));
  list.scrollTop=st;
  if(S.focusEdit){S.focusEdit=false;const i=list.querySelector('.fin');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length)}}
  else if(keep){const n=list.querySelector('.row[data-name="'+keep.replace(/"/g,'\\"')+'"]');if(n)n.focus()}
}
$('#list').addEventListener('keydown',e=>{
  if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
  const rows=[...$('#list').querySelectorAll('.row')],i=rows.indexOf(document.activeElement);if(i<0)return;
  e.preventDefault();const n=rows[Math.max(0,Math.min(rows.length-1,i+(e.key==='ArrowDown'?1:-1)))];n&&n.focus();
});
dropTarget($('#list'),'');dropTarget($('.navlabel'),'');
$('#newfolder').append(icon('folderplus'));
$('#newfolder').addEventListener('click',()=>{S.editing={kind:'new',parent:'',text:''};$('#app').dataset.view='list';renderList()});
$('#sort').value=ls('sc.sort')||'name';
$('#sort').addEventListener('change',()=>{sls('sc.sort',$('#sort').value);renderList()});
$('#foldall').addEventListener('click',()=>{const collapse=S.folders.some(f=>!S.collapsed.has(f));S.collapsed=collapse?new Set(S.folders):new Set();sls('sc.collapsed',JSON.stringify([...S.collapsed]));renderList()});
$('#q').addEventListener('input',e=>{S.q=e.target.value;renderList()});
$('#seg').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;S.filter=b.dataset.f;for(const x of $('#seg').children)x.setAttribute('aria-pressed',String(x===b));renderList()});
function select(name,openDetail){S.sel=name;sls('sc.sel',name||'');if(openDetail)$('#app').dataset.view='detail';lastSig='';render()}

// ---------- detail ----------
const kv=(...p)=>h('dl',{class:'kv'},p.map(([k,v])=>[h('dt',{},k),h('dd',{},v)]));
function organizeCard(c){
  const tags=c.tags||[];
  const fsel=h('select',{'aria-label':'Folder',onchange:e=>organize(c.name,{folder:e.target.value||null})},h('option',{value:''},'Not in a folder'),...S.folders.map(f=>h('option',{value:f},'\u00a0\u00a0'.repeat(segs(f).length-1)+leaf(f))));
  fsel.value=folderOf(c)||'';
  const inp=h('input',{type:'text',id:'taginput',class:'tin',placeholder:tags.length?'Add tag':'Add a tag, e.g. 10k site',maxLength:24,'aria-label':'Add tag',autocomplete:'off',list:'taglist'});
  const add=v=>{v=v.replace(/^#+/,'').trim();if(!v||hasTag(c,v))return;organize(c.name,{tags:[...tags,v]},true)};
  inp.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===','){e.preventDefault();add(inp.value)}
    else if(e.key==='Backspace'&&!inp.value&&tags.length)organize(c.name,{tags:tags.slice(0,-1)},true);
  });
  const editor=h('div',{class:'tagedit'},...tags.map(t=>h('span',{class:'tagchip'},'#'+t,h('button',{type:'button','aria-label':'Remove tag '+t,onclick:()=>organize(c.name,{tags:tags.filter(x=>x!==t)},true)},icon('x')))),inp,h('datalist',{id:'taglist'},...allTags().map(t=>h('option',{value:t.tag}))));
  const pool=[...allTags().map(t=>t.tag),'10k site','client','reference','inspiration'].filter((t,i,a)=>!hasTag(c,t)&&a.findIndex(x=>x.toLowerCase()===t.toLowerCase())===i).slice(0,6);
  return h('section',{class:'card org'},h('h3',{},h('span',{class:'t'},icon('tag'),'Organize'),h('span',{class:'meta'},folderOf(c)?'in '+nice(folderOf(c)):'not in a folder')),
    h('label',{class:'orgrow'},h('span',{class:'meta'},'Folder'),fsel),
    h('div',{class:'orgrow'},h('span',{class:'meta'},'Tags'),editor),
    pool.length?h('div',{class:'orgrow'},h('span',{class:'meta'},'Quick add'),h('div',{class:'sugs'},pool.map(t=>h('button',{type:'button',class:'sug',onclick:()=>add(t)},'+ '+t)))):null,
    S.folders.length?null:h('p',{class:'meta'},'Make a folder with the folder button above the clone list, then drag sites into it. Folders are real folders on your disk.'));
}
function layerCard(c,which){
  if(which==='fe'){const s=feState(c),f=c.frontend;
    return h('section',{class:'card lc lc-fe'},h('h3',{},h('span',{class:'t'},icon('globe'),'Frontend'),h('span',{class:'chip '+chipCls(s)},FE_LBL[s])),
      s==='ok'?h('div',{},h('div',{class:'big'},plural(f.files,'file')),h('div',{class:'meta'},fmtB(f.bytes)+(f.hasIndex?'':' · no index.html'))):h('div',{class:'meta'},'No website files yet.'),
      h('div',{class:'rowline'},btn('sm','chev','Manage',{onclick:()=>setTab('frontend')})));}
  const s=beState(c),be=c.backend;
  return h('section',{class:'card lc lc-be'},h('h3',{},h('span',{class:'t'},icon('db'),'Backend data'),h('span',{class:'chip '+chipCls(s)},BE_LBL[s])),
    be?h('div',{},h('div',{class:'big'},plural(be.captured,'answer')),h('div',{class:'meta'},(be.gated.length?be.gated.length+' need a login · ':'')+(be.missing.length?be.missing.length+" can't be copied · ":'')+fmtB(be.bytes))):h('div',{class:'meta'},s==='todo'?plural(c.endpointsKnown,'API endpoint')+' found, not downloaded.':s==='none'?'No API calls found in this site.':'Not checked yet.'),
    h('div',{class:'rowline'},btn('sm','chev','Manage',{onclick:()=>setTab('backend')})));
}
function liveStats(c){
  const r=c.running;if(!r)return null;
  return h('section',{class:'card lc lc-live'},h('h3',{},h('span',{class:'t'},icon('play'),'Running now'),h('span',{class:'chip on'},'localhost:'+r.port)),
    h('div',{class:'grid2',style:'gap:8px'},
      h('div',{},h('div',{class:'big'},String(r.snapshotHits||0)),h('div',{class:'meta'},'answered from saved data')),
      h('div',{},h('div',{class:'big'},String(r.learned||0)),h('div',{class:'meta'},'learned from live site')),
      h('div',{},h('div',{class:'big'},String(r.stubbed||0)),h('div',{class:'meta'},'calls still stubbed (503)')),
      h('div',{},h('div',{class:'big'},String(r.healed||0)),h('div',{class:'meta'},'missing files healed'))));
}
function epGroups(c){
  const be=c.backend;if(!be)return[];
  return[['saved','Saved',be.savedPaths.map(p=>({p,r:'saved'})),'ok'],['gated','Needs a login',be.gated.map(p=>({p,r:'logged-out answer saved'})),'warn'],['missing',"Can't be copied",be.missing.map(m=>({p:m.path,r:m.reason})),'bad']].filter(g=>g[2].length);
}
function epList(c){
  const wrap=h('div',{style:'display:grid;gap:8px'}),groups=epGroups(c),total=groups.reduce((a,g)=>a+g[2].length,0);
  const body=h('div',{style:'display:grid;gap:8px'});
  const draw=()=>{
    const f=(epFilter[c.name]||'').toLowerCase();body.replaceChildren();
    for(const [key,label,items,tone] of groups){
      const its=f?items.filter(i=>i.p.toLowerCase().includes(f)||i.r.toLowerCase().includes(f)):items;if(!its.length)continue;
      const id=c.name+':'+key,d=h('details',{class:'grp'},h('summary',{},h('span',{class:'chev'},icon('chev')),h('span',{class:'dot '+tone}),label,h('span',{class:'ct'},String(its.length))),
        h('ul',{},its.map(i=>h('li',{},h('code',{},i.p),i.r==='saved'?null:h('em',{},i.r)))));
      d.open=!!f||openG.has(id);d.addEventListener('toggle',()=>{if(!f)d.open?openG.add(id):openG.delete(id)});body.append(d);
    }
    if(!body.children.length)body.append(h('div',{class:'meta'},'No endpoints match.'));
  };
  const head=h('div',{class:'sec'},h('b',{},'Endpoints'),h('span',{class:'meta'},String(total)),h('span',{class:'sp'}));
  if(total>6){const inp=h('input',{type:'search',class:'filt',placeholder:'Filter endpoints','aria-label':'Filter endpoints',value:epFilter[c.name]||'',oninput:e=>{epFilter[c.name]=e.target.value;draw()}});head.append(inp)}
  draw();wrap.append(head,body);return wrap;
}
function jobText(j,pos){
  const gate=(j.result&&j.result.gated?j.result.gated.length:0),miss=(j.result&&j.result.uncaptured?j.result.uncaptured.length:0);
  const tail=(gate?' · '+gate+' need a login':'')+(miss?' · '+miss+" can't be copied":'');
  if(j.state==='queued')return 'Waiting for a free slot'+(pos?' (#'+pos+' in line)':'')+(j.kind==='clone'?' · will be saved as '+j.name:'');
  if(j.state==='running')return j.kind==='backend'?"Reading the site's code for API calls and saving their public answers…":j.phase==='browser'?'Rendering and saving the page in a headless browser…':j.phase==='api'?j.saved+' files saved · now saving backend data…':j.saved+' files saved · '+j.queued+' still to check';
  if(j.state==='done'){
    if(j.kind==='backend')return j.result.none?'No API calls found, so no backend data to download.':plural(j.result.snapshot,'public answer')+' saved'+tail;
    if(j.kind==='frontend')return plural(j.result.saved,'file')+' saved';
    let m=plural(j.result.saved,'file')+' saved'+(j.auto?' · localhost started':'');if(j.api&&j.result.snapshot)m+=' · backend: '+plural(j.result.snapshot,'public answer')+tail;return m;
  }
  if(j.state==='error')return j.error;
  return j.kind==='clone'?'Stopped before finishing, nothing was kept.':'Stopped. What you already had is unchanged.';
}
const JCHIP={queued:['Queued','q'],running:['Copying','on'],done:['Done','done'],error:['Failed','err'],cancelled:['Cancelled','']};
const jobTitle=j=>j.kind==='backend'?'Backend data · '+j.name:j.kind==='frontend'?'Frontend files · '+j.name:j.url;

const PV={full:'100%',tablet:'768px',phone:'390px'};
async function startHere(name){try{await post('/api/start',{name})}catch(e){toast(e.message,'err')}lastSig='';loadClones()}
// the clone shown inside the app, like a small browser pointed at its localhost server
function previewPanel(c){
  if(!c.running){
    const hasFe=c.frontend.files>0;
    return [h('section',{class:'card'},h('h3',{},h('span',{class:'t'},icon('globe'),'Preview')),
      h('div',{class:'meta'},hasFe?'Start localhost to see this clone right here, inside the app.':'Download the frontend first, then start localhost.'),
      h('div',{class:'rowline'},btn('sm primary','play','Start localhost',{disabled:!hasFe,onclick:()=>startHere(c.name)})))];
  }
  if(!PV[S.pvw])S.pvw='full';
  const url='http://localhost:'+c.running.port+'/';
  const frame=h('iframe',{class:'pvframe',src:url,title:'Preview of '+c.name,referrerPolicy:'no-referrer'});
  const wrap=h('div',{class:'pvwrap',style:'width:'+PV[S.pvw]},frame);
  const dev=h('div',{class:'seg pvseg',role:'group','aria-label':'Preview size'});
  for(const [k,l] of [['full','Desktop'],['tablet','Tablet'],['phone','Phone']]){
    dev.append(h('button',{type:'button','data-k':k,'aria-pressed':String(S.pvw===k),onclick:()=>{S.pvw=k;sls('sc.pvw',k);wrap.style.width=PV[k];for(const b of dev.children)b.setAttribute('aria-pressed',String(b.dataset.k===k))}},l));
  }
  return [h('div',{class:'pvbar'},
    btn('sm icon','refresh','',{'aria-label':'Reload',title:'Reload',onclick:()=>{frame.src=url}}),
    btn('sm icon','globe','',{'aria-label':'Back to the home page',title:'Back to the home page',onclick:()=>{frame.src=url}}),
    h('input',{type:'text',readOnly:true,value:url,'aria-label':'Address'}),dev,
    btn('sm ghost','upload','Recapture headlessly',{title:'Automatically render and download the page in a headless browser',onclick:()=>noticeFix(c)}),
    btn('sm','ext','Open in browser',{onclick:()=>window.open(url,'_blank')})),
    h('div',{class:'pvstage'},wrap)];
}
function panelFor(c){
  if(S.tab==='preview')return previewPanel(c);
  const busy=S.busy.has(c.name),hasFe=c.frontend.files>0,b=beState(c),be=c.backend;
  if(S.tab==='frontend'){const f=c.frontend;
    return [h('section',{class:'card lc lc-fe'},h('h3',{},h('span',{class:'t'},icon('globe'),'Frontend'),h('span',{class:'chip '+chipCls(feState(c))},FE_LBL[feState(c)])),
      hasFe?kv(['Files',String(f.files)],['Size',fmtB(f.bytes)],['Entry page',f.hasIndex?'index.html':'none found']):h('div',{class:'meta'},'No website files in this clone. Download the frontend to run it on localhost.'),
      h('div',{class:'rowline'},btn('sm primary',hasFe?'refresh':'dl',hasFe?'Re-download':'Download frontend',{disabled:busy,onclick:()=>layer(c.name,'download-frontend')}),btn('sm danger','trash','Delete frontend',{disabled:busy||!hasFe,onclick:()=>delFe(c)}))),
      h('div',{class:'info'},icon('info'),h('span',{},'The frontend is the public website: pages, scripts, styles, images and fonts, exactly as a visitor receives them.'))];}
  if(S.tab==='backend'){
    const out=[h('section',{class:'card lc lc-be'},h('h3',{},h('span',{class:'t'},icon('db'),'Backend data'),h('span',{class:'chip '+chipCls(b)},BE_LBL[b])),
      be?h('div',{class:'meta'},plural(be.captured,'public answer')+' saved'+(be.gated.length?' · '+be.gated.length+' need a login':'')+(be.missing.length?' · '+be.missing.length+" can't be copied":'')+' · '+fmtB(be.bytes)+(be.takenAt?' · taken '+fmtD(be.takenAt):'')):
        h('div',{class:'meta'},b==='todo'?"This site's code calls "+plural(c.endpointsKnown,'API endpoint')+'. Download their public answers so the copy shows real data.':b==='none'?"No API calls were found in this site's code, so there is no backend data to download.":'Not checked yet. Download to look for API calls and save their public answers.'),
      h('div',{class:'rowline'},btn('sm primary',be?'refresh':'dl',be?'Refresh data':'Download backend data',{disabled:busy,onclick:()=>layer(c.name,'download-backend')}),btn('sm danger','trash','Delete backend data',{disabled:busy||!be,onclick:()=>delBe(c)})))];
    if(be){
      const cb=h('input',{type:'checkbox',checked:!!c.learn,onchange:async()=>{try{await post('/api/layer',{name:c.name,action:'set-learn',value:cb.checked});toast(cb.checked?'Learning is on.':'Learning is off.')}catch(e){toast(e.message,'err')}lastSig='';loadClones()}});
      out.push(h('label',{class:'card switch',title:'While this clone runs on localhost, an API answer it does not have yet is fetched once from the live site (a plain read-only request, no login or cookies), saved, and replayed from then on.'},h('span',{class:'rowline',style:'flex-wrap:nowrap'},cb,h('span',{},h('b',{style:'color:var(--fg);font-weight:600'},'Learn missing answers while it runs'),h('div',{class:'meta'},'Fetches an unseen answer once from the live site, saves it, then replays it.'+(c.running&&c.running.learned?' '+plural(c.running.learned,'answer')+' learned so far.':''))))));
      out.push(epList(c));
    }
    out.push(h('div',{class:'info'},icon('info'),h('span',{},"Public API answers only. A website never exposes its server code or database, so those can't be downloaded. Anything behind a login stays unavailable.")));
    return out;
  }
  if(S.tab==='activity'){
    const js=S.jobs.filter(j=>j.name===c.name),out=[];const ls0=liveStats(c);if(ls0)out.push(ls0);
    out.push(h('section',{class:'card'},h('h3',{},h('span',{class:'t'},icon('layers'),'Recent activity')),
      js.length?h('div',{style:'display:grid;gap:10px'},js.map(j=>{const[l,cl]=JCHIP[j.state]||[j.state,''];return h('div',{style:'display:grid;gap:4px'},h('div',{class:'rowline',style:'justify-content:space-between'},h('b',{style:'font-weight:600'},jobTitle(j)),h('span',{class:'chip '+cl},j.state==='running'&&j.kind==='backend'?'Downloading':l)),h('div',{class:'meta'},jobText(j,0)))})):h('div',{class:'meta'},'Nothing in the queue for this clone. Finished copies clear themselves after a few seconds.')));
    return out;
  }
  const out=[h('div',{class:'grid2'},layerCard(c,'fe'),layerCard(c,'be'))];
  const l=liveStats(c);if(l)out.push(l);
  out.push(organizeCard(c));
  out.push(h('section',{class:'card'},h('h3',{},h('span',{class:'t'},icon('info'),'Details')),kv(['Source',c.origin||c.name],['Copied',fmtD(c.createdAt)||'unknown'],['Backend learning',be?(c.learn?'On':'Off'):'No backend data'])));
  return out;
}
const TABS=[['overview','Overview'],['preview','Preview'],['frontend','Frontend'],['backend','Backend data'],['activity','Activity']];
function setTab(t){S.tab=t;sls('sc.tab',t);lastSig='';render();const b=document.querySelector('.tabs [aria-selected=true]');if(b)b.scrollIntoView({block:'nearest',inline:'nearest'})}
function renderDetail(){
  const box=$('#detail'),st=box.scrollTop,c=sel();box.replaceChildren();
  if(!c){box.append(h('div',{class:'empty'},icon('layers'),h('b',{},S.items.length?'Select a clone':'Nothing cloned yet'),h('span',{},S.items.length?'Pick one on the left to see its frontend, backend data and actions.':'Paste a site URL in the box above and add it to the queue.')));return}
  const hasFe=c.frontend.files>0,mt=[];
  if(c.origin)mt.push(c.origin.replace(/^https?:\/\//,''));if(c.createdAt)mt.push('copied '+fmtD(c.createdAt));
  const mbtn=h('button',{type:'button',class:'icon','aria-label':'More actions','aria-haspopup':'menu','aria-expanded':'false',title:'More actions'},icon('more'));
  mbtn.addEventListener('click',()=>openMenu(mbtn,c));
  const acts=h('div',{class:'acts'});
  if(c.running){acts.append(btn('primary','globe','Preview',{onclick:()=>setTab('preview')}),btn('','ext','Open',{title:'Open in your browser',onclick:()=>window.open('http://localhost:'+c.running.port+'/','_blank')}),btn('','stop','Stop',{onclick:()=>simple('/api/stop',c.name,'Stopped')}))}
  else acts.append(btn('primary','play','Start localhost',{disabled:!hasFe,title:hasFe?'':'Download the frontend first',onclick:()=>startAndOpen(c.name)}));
  acts.append(mbtn);
  const dhead=(h('div',{class:'dhead'},btn('ghost icon back','back','',{'aria-label':'Back to clones',onclick:()=>{$('#app').dataset.view='list'}}),
    h('div',{class:'av lg'+(c.running?' run':''),style:avStyle(c.name),'aria-hidden':'true'},(c.name[0]||'?').toUpperCase()),
    h('div',{class:'who'},h('div',{class:'name'},c.name),h('div',{class:'meta'},mt.join(' · ')),(folderOf(c)||(c.tags||[]).length)?h('div',{class:'tagrow'},folderOf(c)?h('span',{class:'tagchip fchip'},icon('folder'),nice(folderOf(c))):null,...(c.tags||[]).map(t=>h('span',{class:'tagchip'},'#'+t))):null),
    h('span',{class:'chip'+(c.running?' on':'')},c.running?'Running · :'+c.running.port:'Stopped'),acts));
  const tabs=h('div',{class:'tabs',role:'tablist','aria-label':'Clone sections'});
  const nAct=S.jobs.filter(j=>j.name===c.name&&(j.state==='queued'||j.state==='running')).length;
  for(const [id,lbl] of TABS)tabs.append(h('button',{type:'button',role:'tab',id:'tab-'+id,'aria-selected':String(S.tab===id),'aria-controls':'tp','tabindex':S.tab===id?'0':'-1',onclick:()=>setTab(id)},lbl,id==='activity'&&nAct?h('span',{class:'n'},' '+nAct):null));
  tabs.addEventListener('keydown',e=>{const i=TABS.findIndex(t=>t[0]===S.tab);let n=-1;if(e.key==='ArrowRight')n=(i+1)%TABS.length;else if(e.key==='ArrowLeft')n=(i-1+TABS.length)%TABS.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=TABS.length-1;if(n<0)return;e.preventDefault();setTab(TABS[n][0]);const b=document.getElementById('tab-'+TABS[n][0]);if(b)b.focus()});
  box.append(h('div',{class:'dtop'},dhead,tabs),h('div',{class:'panel'+(S.tab==='preview'?' wide':S.tab==='overview'?' overview':''),id:'tp',role:'tabpanel','aria-labelledby':'tab-'+S.tab},panelFor(c)));
  box.scrollTop=st;
}
function render(){
  if(S.sel&&!sel())S.sel=null;
  if(!S.sel&&S.items.length&&matchMedia('(min-width:760px)').matches){S.sel=S.items[0].name}
  const act=document.activeElement,ak=act&&act.id==='tab-'+S.tab?S.tab:null;
  renderList();renderDetail();
  if(ak){const b=document.getElementById('tab-'+ak);if(b)b.focus()}
  if(!S.sel)$('#app').dataset.view='list';
  if(S.refocusTag){S.refocusTag=false;const i=document.getElementById('taginput');if(i)i.focus()}
}
async function loadClones(){
  let items,fd;try{[items,fd]=await Promise.all([fetch('/api/clones').then(r=>r.json()),fetch('/api/folders').then(r=>r.json())])}catch{return}
  S.folders=fd.folders||[];
  const sigItems=S.tab==='preview'?items.map(c=>({...c,running:c.running?{port:c.running.port}:null})):items; // live counters must not rebuild the page while previewing, or the frame would reload
  const sig=JSON.stringify([sigItems,[...S.busy],S.folders,[...S.tagFilter],[...S.collapsed],S.editing&&[S.editing.kind,S.editing.name,S.editing.parent],S.sel,S.tab,S.jobs.filter(j=>j.name===S.sel).map(j=>[j.id,j.state,j.saved,j.phase])]);
  S.items=items;if(sig===lastSig)return;lastSig=sig;render();
}

// ---------- queue tray ----------
const cards=new Map(),prevState=new Map();let trayOpen=false;
function buildJob(j){const p={url:h('span',{class:'jurl'}),chip:h('span',{class:'chip'}),meta:h('div',{class:'meta'}),bar:h('div',{class:'bar'},h('i')),btns:h('div',{class:'rowline'})};return{card:h('div',{class:'job'},h('div',{class:'jt'},p.url,p.chip),p.meta,p.bar,p.btns),state:null,p}}
function updateJob(j,pos){
  let c=cards.get(j.id);if(!c){c=buildJob(j);cards.set(j.id,c)}
  const [l0,cl]=JCHIP[j.state]||[j.state,''];
  c.p.chip.textContent=j.state==='running'&&j.kind==='backend'?'Downloading':l0;c.p.chip.className='chip '+cl;
  c.p.bar.hidden=j.state!=='running';c.p.url.textContent=jobTitle(j);c.p.meta.textContent=jobText(j,pos);
  if(c.state!==j.state){c.state=j.state;c.p.btns.replaceChildren();
    if(j.state==='queued'||j.state==='running')c.p.btns.append(btn('sm','x','Cancel',{onclick:()=>post('/api/cancel',{id:j.id}).then(pollJobs)}));
    else c.p.btns.append(btn('sm ghost','x','Dismiss',{onclick:()=>post('/api/dismiss',{id:j.id}).then(pollJobs)}));}
  return c.card;
}
function setTray(open){trayOpen=open;$('#queue').hidden=!open;$('#thead').setAttribute('aria-expanded',String(open))}
$('#thead').addEventListener('click',()=>setTray(!trayOpen));
let activeJobs=0;
async function pollJobs(){
  let d;try{d=await (await fetch('/api/jobs')).json()}catch{return}
  S.jobs=d.jobs;S.parallel=d.parallel;
  if(document.activeElement!==$('#par'))$('#par').value=String(d.parallel);
  const live=d.jobs.filter(j=>j.state==='queued'||j.state==='running'),run=live.filter(j=>j.state==='running').length,que=live.length-run;
  activeJobs=live.length;
  const tray=$('#tray');tray.hidden=!d.jobs.length;$('#app').classList.toggle('hastray',!!d.jobs.length);
  const bits=[];if(run)bits.push(run+' copying');if(que)bits.push(que+' queued');const fin=d.jobs.length-live.length;if(fin)bits.push(fin+' finished');
  $('#tsum').textContent=bits.join(' · ')||'Queue';
  const nb=new Set(live.map(j=>j.name));
  const changed=[...nb].sort().join()!==[...S.busy].sort().join();S.busy=nb;
  const seen=new Set(),order=[];let pos=0;
  for(const j of d.jobs){
    seen.add(j.id);order.push(updateJob(j,j.state==='queued'?++pos:0));
    if(prevState.get(j.id)!==j.state)noticeFor(j);
    if(prevState.get(j.id)!==j.state&&j.state==='done'){if(j.kind==='clone'){S.sel=j.name;sls('sc.sel',j.name)}lastSig='';loadClones()}
    prevState.set(j.id,j.state);
  }
  for(const [id] of cards)if(!seen.has(id)){cards.delete(id);prevState.delete(id)}
  const q=$('#queue');order.forEach((n,i)=>{if(q.children[i]!==n)q.insertBefore(n,q.children[i]||null)});while(q.children.length>order.length)q.lastChild.remove();
  if(changed){lastSig='';loadClones()}
}

// ---------- composer ----------
const urlBox=$('#url');
urlBox.addEventListener('input',()=>{urlBox.style.height='auto';urlBox.style.height=Math.min(urlBox.scrollHeight,140)+'px'});
urlBox.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#f').requestSubmit()}});
$('#optbtn').addEventListener('click',()=>{const r=$('#optrow'),o=r.hidden;r.hidden=!o;$('#optbtn').setAttribute('aria-expanded',String(o))});
(function(){
const sp=document.querySelector('.split'),rz=document.getElementById('rz');if(!sp||!rz)return;
const MIN=220,MAX=()=>Math.min(640,Math.round(innerWidth*0.6));
const clamp=w=>Math.max(MIN,Math.min(MAX(),w));
const set=(w,save)=>{w=clamp(w);sp.style.setProperty('--sidew',w+'px');rz.setAttribute('aria-valuenow',String(w));if(save){try{localStorage.setItem('sc.sidew',String(w))}catch{}}};
try{const v=Number(localStorage.getItem('sc.sidew'));if(v)set(v)}catch{}
rz.addEventListener('pointerdown',e=>{e.preventDefault();rz.setPointerCapture(e.pointerId);rz.classList.add('on');document.body.classList.add('rzing');
const left=sp.getBoundingClientRect().left;
const mv=ev=>set(ev.clientX-left,false);
const up=ev=>{rz.releasePointerCapture(ev.pointerId);rz.classList.remove('on');document.body.classList.remove('rzing');rz.removeEventListener('pointermove',mv);rz.removeEventListener('pointerup',up);set(ev.clientX-left,true)};
rz.addEventListener('pointermove',mv);rz.addEventListener('pointerup',up)});
rz.addEventListener('dblclick',()=>{sp.style.removeProperty('--sidew');try{localStorage.removeItem('sc.sidew')}catch{}});
rz.addEventListener('keydown',e=>{if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();const cur=document.querySelector('.side').getBoundingClientRect().width;set(cur+(e.key==='ArrowRight'?16:-16),true)});
addEventListener('resize',()=>{const w=document.querySelector('.side').getBoundingClientRect().width;if(w>MAX())set(MAX(),false)});
})();
$('#par').addEventListener('change',()=>post('/api/settings',{parallel:Number($('#par').value)}).then(pollJobs).catch(e=>toast(e.message,'err')));
$('#f').addEventListener('submit',async ev=>{
  ev.preventDefault();const text=urlBox.value.trim();if(!text)return;
  try{
    const r=await post('/api/clone',{url:text,auto:$('#auto').checked,api:$('#api').checked});
    urlBox.value='';urlBox.style.height='auto';
    if(r.added.length){toast('Added '+plural(r.added.length,'site')+' to the queue');setTray(true)}
    if(r.skipped.length)toast('Skipped '+r.skipped.map(s=>s.input+' ('+s.reason+')').join(', '),r.added.length?'ok':'err');
    pollJobs();
  }catch(e){toast(e.message,'err')}
  urlBox.focus();
});
// ---------- "this may be empty" prompt, and importing a page saved with Ctrl+S ----------
const siteOf=c=>(c.origin||('https://'+c.name))+'/';
function addNotice(n){if(S.notices.some(x=>x.key===n.key))return;S.notices.push(n);renderNotice()}
function noticeFor(j){
  if(j.state==='done'&&(j.kind==='clone'||j.kind==='frontend')&&j.result&&j.result.suspect)
    addNotice({key:'s'+j.id,step:'check',name:j.name,url:j.url,reason:j.result.suspect});
  else if(j.state==='error'&&/bot protection|refused to give/i.test(j.error||''))
    addNotice({key:'e'+j.id,step:'fix',name:null,url:j.url,text:j.url+' would not give its page to fibrous-cloner (its bot protection wants a real browser).'});
}
async function noticeFix(c){await layer(c.name,'capture-browser');toast('Headless capture queued. The page and assets will be saved automatically.')}
async function runClone(name){try{await post('/api/start',{name})}catch(e){toast(e.message,'err')}lastSig='';await loadClones()}
function renderNotice(){
  const box=$('#notice'),n=S.notices[0];box.replaceChildren();box.hidden=!n;if(!n)return;
  const next=()=>{S.notices.shift();renderNotice()};
  if(n.step==='check'){
    box.append(icon('info'),h('div',{class:'ntext'},h('b',{},n.name+' may have returned an empty page. '),h('span',{},n.reason+' Some sites only show their content to a real browser. Check it in Preview or open the localhost link. Did the clone fail?')),
      h('div',{class:'nbtns'},
        btn('sm','globe','Preview',{onclick:async()=>{select(n.name,true);await runClone(n.name);setTab('preview')}}),
        btn('sm','ext','Open localhost',{onclick:()=>startAndOpen(n.name)}),
        btn('sm primary','dl','Capture automatically',{onclick:()=>{next();const c=S.items.find(c=>c.name===n.name);if(c)noticeFix(c)}}),
        btn('sm ghost','','Nevermind',{onclick:next})));
  }else{
    box.append(icon('upload'),h('div',{class:'ntext'},h('b',{},n.text+' '),h('span',{},'Retry the download in a headless browser. The rendered page and its loaded assets are saved automatically.')),
      h('div',{class:'nbtns'},
        btn('sm primary','dl','Retry headlessly',{onclick:async()=>{next();if(n.name){const c=S.items.find(c=>c.name===n.name);if(c)await noticeFix(c)}else{try{await post('/api/clone',{urls:[n.url],auto:true,api:true});pollJobs()}catch(e){toast(e.message,'err')}}}}),
        btn('sm ghost','','Nevermind',{onclick:next})));
  }
}
const IM={path:'',repair:false,watch:null};
function impReady(){$('#impgo').disabled=!(IM.path&&$('#impurl').value.trim())}
async function impSet(p){
  IM.path=p;$('#imppath').textContent=p;$('#impmsg').textContent='';
  try{
    const r=await post('/api/import/inspect',{path:p});
    if(r.url&&!$('#impurl').value.trim())$('#impurl').value=r.url;
    $('#impmsg').textContent=(r.title?'“'+r.title+'” · ':'')+(r.kind==='mhtml'?'single-file page':r.hasAssets?'page and its files folder found':'page only (no files folder next to it)')+(r.url?'':' · type the site address below');
  }catch(e){IM.path='';$('#imppath').textContent='No file chosen';$('#impmsg').textContent=e.message}
  impReady();
}
function stopWatch(){if(IM.watch){clearInterval(IM.watch.t);clearTimeout(IM.watch.to);IM.watch=null}$('#impwatch').replaceChildren(icon('refresh'),'Watch Downloads')}
function startWatch(){
  stopWatch();$('#impwatch').replaceChildren(icon('x'),'Stop watching');
  const since=Date.now()-1500,seen=new Map();
  $('#impmsg').textContent='Waiting for a saved page in your Downloads folder. Press Ctrl+S on the site in your browser and choose “Webpage, Complete”.';
  const tick=async()=>{try{const r=await post('/api/import/recent',{since}),f=r.files[0];if(!f)return;const sig=f.size+':'+f.assets;if(f.size>0&&seen.get(f.path)===sig){stopWatch();impSet(f.path)}else seen.set(f.path,sig)}catch{/* try again */}};
  IM.watch={t:setInterval(tick,1200),to:setTimeout(()=>{stopWatch();$('#impmsg').textContent='Stopped waiting. Use Choose file… if you saved it somewhere else.'},240000)};
}
function openImport(o={}){
  IM.path='';IM.repair=!!o.repair;stopWatch();
  $('#imptitle').textContent=o.repair?'Download the page’s HTML/CSS':'Import a saved page';
  $('#imppath').textContent='No file chosen';$('#impurl').value=o.url||'';$('#impstrip').checked=true;$('#impfetch').checked=true;$('#impmsg').textContent='';$('#impgo').disabled=true;
  const into=$('#impinto');into.replaceChildren(h('option',{value:''},'A new clone'),...S.items.map(c=>h('option',{value:c.name},(o.repair&&c.name===o.into?'Replace the home page of ':'Add a page to ')+c.name)));
  into.value=S.items.some(c=>c.name===o.into)?o.into:'';
  $('#impdlg').showModal();
  if(o.open&&o.url)window.open(o.url,'_blank');
  if(o.watch)startWatch();
}
$('#impbtn').append(icon('upload'),'Import');
$('#impbtn').addEventListener('click',()=>openImport());
$('#impbrowse').append(icon('folder'),'Choose file…');
$('#impbrowse').addEventListener('click',async()=>{stopWatch();$('#impmsg').textContent='Opening the file picker…';try{const r=await post('/api/import/pick',{});$('#impmsg').textContent='';if(r.path)impSet(r.path)}catch(e){$('#impmsg').textContent=e.message}});
$('#impwatch').addEventListener('click',()=>{IM.watch?stopWatch():startWatch()});
$('#impurl').addEventListener('input',impReady);
$('#impcancel').addEventListener('click',()=>$('#impdlg').close());
$('#impdlg').addEventListener('close',stopWatch);
$('#impgo').addEventListener('click',async()=>{
  const go=$('#impgo');go.disabled=true;$('#impmsg').textContent=$('#impfetch').checked?'Importing, then downloading what the page needs…':'Importing…';
  try{
    const r=await post('/api/import',{path:IM.path,url:$('#impurl').value.trim(),into:$('#impinto').value,stripScripts:$('#impstrip').checked,fetchMissing:$('#impfetch').checked,asHome:IM.repair});
    $('#impdlg').close();
    toast(r.standalone?'Saved as a standalone HTML page':'Imported '+plural(r.saved,'file')+(r.fetched?' and downloaded '+plural(r.fetched,'more file'):'')+(r.failed?' ('+r.failed+' could not be fetched)':''));
    lastSig='';await loadClones();select(r.name,true);await runClone(r.name);setTab('preview'); // show it right away
  }catch(e){$('#impmsg').textContent=e.message;if(/address/i.test(e.message))$('#impurl').focus();go.disabled=false;impReady()}
});
const es=new EventSource('/api/events');
$('#quit').addEventListener('click',async()=>{
  const ok=await ask('Quit fibrous-cloner?','Any copies running on localhost will stop.'+(activeJobs?' '+plural(activeJobs,'unfinished copy')+' in the queue will be discarded.':''),'Quit',{normal:true});if(!ok)return;
  es.close();try{await post('/api/quit',{})}catch{}
  document.body.replaceChildren(h('div',{class:'empty',style:'height:100vh'},h('b',{},'fibrous-cloner stopped'),h('span',{},'You can close this window.')));
  setTimeout(()=>window.close(),300);
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){if(!menu.hidden||!setPop.hidden){closePops(true);return}}
  const t=e.target,typing=t&&(t.tagName==='INPUT'&&t.type!=='checkbox'||t.tagName==='TEXTAREA'||t.tagName==='SELECT');
  if(e.key==='Enter'&&e.ctrlKey&&t===urlBox){e.preventDefault();$('#f').requestSubmit();return}
  if(typing||e.ctrlKey||e.metaKey||e.altKey||$('#dlg').open)return;
  if(e.key==='/'){e.preventDefault();$('#app').dataset.view='list';$('#q').focus()}
  else if(e.key==='n'){e.preventDefault();urlBox.focus()}
});
loadClones().then(pollJobs);setInterval(loadClones,4000);setInterval(pollJobs,800);
</script></body></html>`;
