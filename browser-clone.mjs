import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capturePage } from './browser-capture.mjs';
import { crawl, importSaved, readMeta, writeMeta, downloadHome, fetchMissingAssets, frontendStats, META } from './sitecloner.mjs';

// Render into a staging directory so a failed/cancelled capture cannot replace a good clone.
export async function captureClone(url, out, { signal, onPhase, ...captureOptions } = {}) {
  onPhase?.('browser');
  const snapshot = await capturePage(url, { ...captureOptions, signal });
  return importSnapshot(snapshot, out, { signal, rendered: true });
}

async function importSnapshot(snapshot, out, { signal, rendered }) {
  signal?.throwIfAborted();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fibrous-import-'));
  try {
    const file = path.join(temp, rendered ? 'page.mhtml' : 'page.html'), stage = path.join(temp, 'site');
    let data = snapshot.data;
    if (!rendered && !/<base\b/i.test(data)) data = data.replace(/<head\b[^>]*>/i, m => m + '<base href="' + new URL(snapshot.url).pathname.replace(/"/g, '%22') + '">');
    fs.writeFileSync(file, data);
    fs.mkdirSync(stage);
    const previous = readMeta(out);
    if (previous) fs.copyFileSync(path.join(out, META), path.join(stage, META));
    importSaved({ file, url: snapshot.url, outDir: stage, existing: !!previous, asHome: true, stripScripts: rendered });
    if (!rendered) {
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try { await fetchMissingAssets(stage, snapshot.url, { stripScripts: false, max: 128, signal: controller.signal }); }
      catch (e) { if (signal?.aborted) throw e; /* Commit available source when the asset budget expires. */ }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    signal?.throwIfAborted();
    const meta = { ...readMeta(stage), ...previous, ...(rendered ? { renderedAt: new Date().toISOString() } : {}), captureStatus: rendered ? 'rendered' : 'partial', captureWarning: null, source: previous?.source || (rendered ? 'headless browser' : 'public HTML') };
    if (!rendered) { delete meta.renderedAt; meta.source = 'public HTML'; }
    fs.mkdirSync(out, { recursive: true });
    for (const entry of fs.readdirSync(stage)) {
      if (entry !== META) fs.cpSync(path.join(stage, entry), path.join(out, entry), { recursive: true });
    }
    writeMeta(out, meta);
    return { meta, saved: frontendStats(stage).files, failed: [], apiCalls: [], spaRoutes: [], apiSnap: null, rendered, partial: !rendered };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

// Repairs must try both supported download paths, not repeatedly retry a blocked browser.
export async function repairClone(url, out, opts = {}) {
  try { return await captureClone(url, out, opts); }
  catch (browserError) {
    if (opts.signal?.aborted) throw browserError;
    return nativeFallback(url, out, opts, browserError);
  }
}

async function nativeFallback(url, out, opts, browserError) {
  opts.onPhase?.('source');
  try {
    const snapshot = await downloadHome(url, opts.signal);
    const result = await importSnapshot(snapshot, out, { signal: opts.signal, rendered: false });
    result.meta.captureWarning = browserError.message;
    writeMeta(out, result.meta);
    return { ...result, browserError: browserError.message };
  } catch (nativeError) {
    if (opts.signal?.aborted) throw nativeError;
    throw new Error(browserError.message + '; native fallback: ' + nativeError.message);
  }
}

export async function cloneWithBrowser(url, out, maxFiles, progress, signal, opts = {}) {
  let result;
  try { result = await crawl(url, out, maxFiles, progress, signal, opts); }
  catch (e) {
    if (signal?.aborted || e.code === 'SIZE_CAP' || e.code === 'PARKED_DOMAIN') throw e;
    return repairClone(url, out, { signal, onPhase: opts.onPhase });
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
    const text = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').trim();
    if (blocked || !html || (!text && !/<(?:img|svg|canvas|video)\b/i.test(html))) return nativeFallback(url, out, { signal, onPhase: opts.onPhase }, e);
    // Keep successfully downloaded source when the optional rendered enhancement is refused.
    result.meta = { ...result.meta, captureStatus: 'partial', captureWarning: e.message };
    writeMeta(out, result.meta);
    return { ...result, partial: true, browserError: e.message };
  }
}
