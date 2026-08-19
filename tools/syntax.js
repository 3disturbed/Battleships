// Syntax-check every .js file (all ESM) without executing anything:
// pipe each file through `node --check --input-type=module`.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['server.js', 'game', 'lib', 'public/js', 'tools', 'tests'];

function collect(path, out) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isDirectory()) {
    for (const f of readdirSync(path)) collect(join(path, f), out);
  } else if (path.endsWith('.js')) {
    out.push(path);
  }
}

const files = [];
for (const t of targets) collect(join(root, t), files);

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', '--input-type=module', '-'], {
    input: readFileSync(file, 'utf8'),
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    failed++;
    console.error(`SYNTAX ${relative(root, file)}\n${res.stderr}`);
  }
}

console.log(`${files.length - failed}/${files.length} files pass syntax check`);
process.exit(failed ? 1 : 0);
