// Chromium's pipe transport works on Node 18 without a WebSocket/npm dependency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function findCaptureBrowser() {
  const explicit = process.env.FIBROUS_CLONER_BROWSER;
  const candidates = [explicit];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      for (const rel of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe', 'BraveSoftware/Brave-Browser/Application/brave.exe']) candidates.push(path.join(base, rel));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) candidates.push(path.join(dir, name));
  }
  for (const f of candidates.filter(Boolean)) { try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  throw new Error('Automatic capture needs Chrome, Edge or Chromium installed (or FIBROUS_CLONER_BROWSER set to its executable).');
}

export async function capturePage(url, { signal, timeoutMs = 60000, settleMs = 1800 } = {}) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only HTTP and HTTPS pages can be captured');
  signal?.throwIfAborted();
  const executable = findCaptureBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fibrous-capture-'));
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--remote-debugging-pipe', '--user-data-dir=' + profile, '--window-size=1440,1000', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', failure, activeSession, mainFrame, documentStatus;
  const pending = new Map();
  const fail = (e) => { failure ||= e; for (const p of pending.values()) p.reject(failure); pending.clear(); };
  const abort = () => fail(new Error('cancelled'));
  const timer = setTimeout(() => { fail(new Error('Headless capture timed out')); child.kill(); }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Headless browser closed before capture finished')));
  child.stdio[3].on('error', fail);
  child.stdio[4].on('error', fail);
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!raw) continue;
      let m; try { m = JSON.parse(raw); } catch { fail(new Error('Invalid browser response')); continue; }
      if (m.sessionId === activeSession && m.method === 'Network.responseReceived' && m.params.type === 'Document' && m.params.frameId === mainFrame) documentStatus = m.params.response.status;
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (failure || signal?.aborted) return reject(failure || new Error('cancelled'));
    const id = ++seq; pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    activeSession = sessionId;
    const page = (m, p) => send(m, p, sessionId);
    await page('Page.enable');
    await page('Runtime.enable');
    const { frameTree } = await page('Page.getFrameTree');
    mainFrame = frameTree.frame.id;
    await page('Network.enable');
    const navigation = await page('Page.navigate', { url });
    if (navigation.errorText) throw new Error('Browser navigation failed: ' + navigation.errorText);
    const deadline = Date.now() + Math.min(30000, timeoutMs / 2);
    let ready = false;
    while (Date.now() < deadline) {
      const r = await page('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result.value === 'complete' || r.result.value === 'interactive') { ready = true; break; }
      await delay(150, undefined, { signal });
    }
    if (!ready) throw new Error('The page did not finish loading before the capture deadline');
    await delay(settleMs, undefined, { signal });
    // Trigger common lazy-loaded images and sections, with a bounded scroll budget.
    await page('Runtime.evaluate', { expression: `(async()=>{for(let i=0;i<10;i++){scrollBy(0,innerHeight*.8);await new Promise(r=>setTimeout(r,180));if(scrollY+innerHeight>=document.documentElement.scrollHeight)break}scrollTo(0,0);await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,3000))]);await new Promise(r=>setTimeout(r,500))})()`, awaitPromise: true });
    const state = await page('Runtime.evaluate', { expression: '({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,2000)||"",media:document.querySelectorAll("img,svg,canvas,video").length})', returnByValue: true });
    const info = state.result.value;
    if (documentStatus >= 400) throw new Error('The browser received HTTP ' + documentStatus + '; the page was not imported');
    if (!info || !/^https?:/.test(info.url)) throw new Error('The browser did not load a web page');
    if (new URL(info.url).hostname === 'forsale.godaddy.com' && parsed.hostname !== 'forsale.godaddy.com') throw new Error('This address redirects to a parked domain sale page, not the requested website');
    if (/^(just a moment|access denied|attention required|verify you are human|vercel security checkpoint|security check|404|403)/i.test(info.title.trim()) || /verify (?:that )?you are human|performing security verification/i.test(info.text)) throw new Error('The site still requires an interactive verification; headless capture could not load its content');
    if (!info.text.trim() && !info.media) throw new Error('The browser loaded an empty page; it was not imported');
    // MHTML stores DOM and resources, not canvas pixels. Bake a bounded number of
    // rendered canvases into images before removing scripts during import.
    const canvases = await page('Runtime.evaluate', { expression: 'Array.from(document.querySelectorAll("canvas")).slice(0,6).map((c,i)=>{c.dataset.fibrousCapture=String(i);const r=c.getBoundingClientRect();return {i,x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}})', returnByValue: true });
    for (const rect of canvases.result.value || []) {
      if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.width * rect.height > 8000000) continue;
      const image = await page('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }, captureBeyondViewport: true });
      await page('Runtime.evaluate', { expression: `(()=>{const c=document.querySelector('canvas[data-fibrous-capture="${rect.i}"]');if(!c)return;const s=getComputedStyle(c),img=document.createElement('img');for(const a of c.attributes)img.setAttribute(a.name,a.value);img.alt='Captured canvas';img.src=${JSON.stringify('data:image/png;base64,' + image.data)};for(const k of s)img.style.setProperty(k,s.getPropertyValue(k));c.replaceWith(img)})()` });
    }
    const { data } = await page('Page.captureSnapshot', { format: 'mhtml' });
    if (!data || data.length > 400e6) throw new Error('The browser snapshot is empty or too large');
    return { data, url: info.url };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    // Close gracefully first; killing only the browser parent can leave renderers behind.
    if (!child.killed && child.exitCode === null && !failure) {
      await Promise.race([send('Browser.close').catch(() => {}), delay(1500)]);
    }
    if (child.exitCode === null) child.kill();
    fail(new Error('Capture finished'));
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
  }
}
