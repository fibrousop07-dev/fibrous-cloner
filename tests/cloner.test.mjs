import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crawl } from '../sitecloner.mjs';

test('downloads a local page and linked stylesheet without public-network access', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local fixture</title><link rel="stylesheet" href="/style.css"><h1>Owned fixture</h1>'); }
    else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('h1 { color: teal }'); }
    else { res.statusCode = 404; res.end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fibrous-cloner-test-'));
  try {
    const out = path.join(temp, 'copy');
    const result = await crawl(`http://127.0.0.1:${server.address().port}/`, out, 10, null, null, { snapshotApi: false });
    assert.ok(result.saved >= 2);
    assert.match(await fs.readFile(path.join(out, 'index.html'), 'utf8'), /Owned fixture/);
    assert.match(await fs.readFile(path.join(out, 'style.css'), 'utf8'), /color: teal/);
    assert.ok(await fs.stat(path.join(out, '_sitecloner.json')));
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
