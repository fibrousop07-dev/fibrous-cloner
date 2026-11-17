// Syntax-checks every tracked .mjs file with `node --check` (zero deps). Run: npm run check
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', '-z', '--', '*.mjs'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter((f) => f && !/^(private|node_modules)\//.test(f));
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { cwd: root, stdio: 'pipe' }); }
  catch (e) { failed++; process.stderr.write(`FAIL ${f}\n${e.stderr || e.message}\n`); }
}
console.log(`node --check: ${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
