import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capturePage, findCaptureBrowser } from '../browser-capture.mjs';
import { captureClone, cloneWithBrowser } from '../browser-clone.mjs';
import { normalizeUrl, crawl } from '../sitecloner.mjs';

let browser;
try { browser = findCaptureBrowser(); } catch { /* Browser integration tests report why they are skipped. */ }

async function fixture(run) {
  const server = http.createServer((req, res) => {
    if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end('h1 { color: rgb(18, 110, 90) }'); }
    if (req.url === '/image.svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="teal"/></svg>'); }
    if (req.url === '/denied') { res.statusCode = 403; res.setHeader('content-type', 'text/html'); return res.end('<title>Forbidden</title><p>No access</p>'); }
    if (req.url !== '/' && req.url !== '/browser-only') { res.statusCode = 404; return res.end(); }
    if (req.url === '/browser-only' && !/HeadlessChrome/.test(req.headers['user-agent'] || '')) { res.statusCode = 403; return res.end('Needs a browser'); }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Rendered fixture</title><link rel="stylesheet" href="/style.css"><div id="app"></div><canvas width="40" height="40"></canvas><script>const ctx=document.querySelector("canvas").getContext("2d");ctx.fillStyle="teal";ctx.fillRect(0,0,40,40);setTimeout(()=>{document.querySelector("#app").innerHTML=\'<h1>Content rendered by JavaScript</h1><img src="/image.svg">\'},120)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fibrous-browser-test-'));
  try { await run(`http://127.0.0.1:${server.address().port}`, temp); }
  finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); }
}

test('an already cancelled capture exits without launching a browser', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(capturePage('http://localhost/', { signal: controller.signal }), { name: 'AbortError' });
});

test('URLs pasted with escaped punctuation are normalized', () => {
  assert.equal(normalizeUrl('https\\://www\\.mbandf.com\\'), 'https://www.mbandf.com/');
  assert.equal(normalizeUrl('https://example.com/a?x=1'), 'https://example.com/a?x=1');
});

test('a regional redirect gets a localhost home page with the correct relative base', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/en/landing' }); return res.end(); }
    if (req.url === '/en/landing') { res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>Regional site</title></head><body>Regional homepage</body></html>'); }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fibrous-redirect-test-'));
  try {
    await crawl(`http://127.0.0.1:${server.address().port}/`, temp, 10, () => {}, undefined, { snapshotApi: false });
    const home = await fs.readFile(path.join(temp, 'index.html'), 'utf8');
    assert.match(home, /Regional homepage/);
    assert.match(home, /<base href="\/en\/landing">/);
  } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); }
});

test('headless capture imports hydrated HTML, styles and images as local files', { skip: !browser && 'Chrome/Edge/Chromium is not installed' }, async () => {
  await fixture(async (url, temp) => {
    const out = path.join(temp, 'copy');
    const r = await captureClone(url, out, { settleMs: 200 });
    assert.equal(r.rendered, true);
    const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /Content rendered by JavaScript/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.match(html, /(?:href|src)="\/style\.css"/);
    assert.match(html, /src="\/image\.svg"/);
    assert.match(html, /alt="Captured canvas"/);
    assert.match(html, /data:image\/png;base64,/);
    assert.doesNotMatch(html, /<canvas\b/);
    assert.match(await fs.readFile(path.join(out, 'style.css'), 'utf8'), /110/);
    assert.match(await fs.readFile(path.join(out, 'image.svg'), 'utf8'), /<svg/);
  });
});

test('a refused script download automatically falls back to headless capture', { skip: !browser && 'Chrome/Edge/Chromium is not installed' }, async () => {
  await fixture(async (url, temp) => {
    const out = path.join(temp, 'fallback');
    const phases = [];
    const r = await cloneWithBrowser(url + '/browser-only', out, 10, () => {}, undefined, { snapshotApi: false, onPhase: p => phases.push(p) });
    assert.equal(r.rendered, true);
    assert.ok(phases.includes('browser'));
    assert.match(await fs.readFile(path.join(out, 'index.html'), 'utf8'), /Content rendered by JavaScript/);
  });
});

test('a successful download of a JavaScript shell is rendered automatically', { skip: !browser && 'Chrome/Edge/Chromium is not installed' }, async () => {
  await fixture(async (url, temp) => {
    const out = path.join(temp, 'hydrated');
    const r = await cloneWithBrowser(url, out, 10, () => {}, undefined, { snapshotApi: false });
    assert.equal(r.rendered, true);
    assert.match(await fs.readFile(path.join(out, 'index.html'), 'utf8'), /<h1>Content rendered by JavaScript<\/h1>/);
  });
});

test('failed capture and cancellation preserve an existing clone', { skip: !browser && 'Chrome/Edge/Chromium is not installed' }, async () => {
  await fixture(async (url, temp) => {
    const out = path.join(temp, 'existing'); await fs.mkdir(out);
    const meta = JSON.stringify({ origin: url, url, tags: ['reference'] });
    await fs.writeFile(path.join(out, 'index.html'), 'Keep existing page');
    await fs.writeFile(path.join(out, '_sitecloner.json'), meta);
    await assert.rejects(captureClone(url + '/denied', out, { settleMs: 100 }), /HTTP 403/);
    const controller = new AbortController();
    const pending = captureClone(url, out, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 200);
    try { await assert.rejects(pending, /cancelled|abort/i); } finally { clearTimeout(timer); }
    assert.equal(await fs.readFile(path.join(out, 'index.html'), 'utf8'), 'Keep existing page');
    assert.equal(await fs.readFile(path.join(out, '_sitecloner.json'), 'utf8'), meta);
  });
});
