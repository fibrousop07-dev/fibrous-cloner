// App launcher: starts the panel server in the background (if needed) and opens it in its own window.
// Started by the Start-menu shortcut via launch.vbs (no console window).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'SiteCloner');
const STATE = path.join(STATE_DIR, 'panel.json');
fs.mkdirSync(STATE_DIR, { recursive: true });

async function alive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'sitecloner';
  } catch { return false; }
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };

async function ensureServer() {
  const s = readState();
  if (s && (await alive(s.port))) return s.port;
  try { fs.rmSync(STATE, { force: true }); } catch { /* ignore */ }
  spawn(process.execPath, [path.join(HERE, 'ui.mjs'), '--no-open', '--app', '--port', '4200'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const n = readState();
    if (n && (await alive(n.port))) return n.port;
  }
  throw new Error('panel did not start');
}

function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rels = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
  for (const rel of rels) for (const base of pf) { const p = path.join(base, rel); if (fs.existsSync(p)) return p; }
  return null;
}

const port = await ensureServer();
const url = `http://localhost:${port}/`;
const browser = findBrowser();
if (browser) {
  spawn(browser, [`--app=${url}`, '--window-size=1100,800', `--user-data-dir=${path.join(STATE_DIR, 'profile')}`, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
} else {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
