import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capturePage } from './browser-capture.mjs';
import { crawl, importSaved, readMeta, writeMeta, META } from './sitecloner.mjs';

// Render into a staging directory so a failed/cancelled capture cannot replace a good clone.
export async function captureClone(url, out, { signal, onPhase, ...captureOptions } = {}) {
  onPhase?.('browser');
  const snapshot = await capturePage(url, { ...captureOptions, signal });
  signal?.throwIfAborted();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fibrous-import-'));
  try {
    const file = path.join(temp, 'page.mhtml'), stage = path.join(temp, 'site');
    fs.writeFileSync(file, snapshot.data);
    fs.mkdirSync(stage);
    const previous = readMeta(out);
    if (previous) fs.copyFileSync(path.join(out, META), path.join(stage, META));
    const result = importSaved({ file, url: snapshot.url, outDir: stage, existing: !!previous, asHome: true, stripScripts: true });
    signal?.throwIfAborted();
    const meta = { ...readMeta(stage), ...previous, renderedAt: new Date().toISOString(), source: previous?.source || 'headless browser' };
    fs.mkdirSync(out, { recursive: true });
    for (const entry of fs.readdirSync(stage)) {
      if (entry !== META) fs.cpSync(path.join(stage, entry), path.join(out, entry), { recursive: true });
    }
    writeMeta(out, meta);
    return { meta, saved: result.saved, failed: [], apiCalls: [], spaRoutes: [], apiSnap: null, rendered: true };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function cloneWithBrowser(url, out, maxFiles, progress, signal, opts = {}) {
  let result;
  try { result = await crawl(url, out, maxFiles, progress, signal, opts); }
  catch (e) {
    if (signal?.aborted || e.code === 'SIZE_CAP') throw e;
    return captureClone(url, out, { signal, onPhase: opts.onPhase });
  }
  signal?.throwIfAborted();
  const home = path.join(out, 'index.html');
  const html = fs.existsSync(home) ? fs.readFileSync(home, 'utf8') : '';
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  const blocked = /^(just a moment|access denied|attention required|vercel security checkpoint|security check)/i.test(title.trim());
  if (!blocked && html && !/<script\b/i.test(html)) return result;
  try {
    const rendered = await captureClone(url, out, { signal, onPhase: opts.onPhase });
    return { ...result, meta: rendered.meta, saved: Math.max(result.saved, rendered.saved), rendered: true };
  } catch (e) {
    if (signal?.aborted) throw e;
    if (blocked || !html) throw e;
    // Keep successfully downloaded source when the optional rendered enhancement is refused.
    return { ...result, browserError: e.message };
  }
}
