#!/usr/bin/env node
// tools/test.mjs — zero-dependency test runner for dsh-key-rotation.
//
// The published package declares `node tools/test.mjs`, so this runner restores
// that entry point without adding any dependency: it uses Node's built-in test
// runner (node:test + node:assert), available on Node >= 18.
//
//   node tools/test.mjs            run every test file
//   node tools/test.mjs --core     run only the model-quota core suite
//   node tools/test.mjs <pattern>  run test files whose path matches <pattern>

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

/** Every `*.test.mjs` under test/, depth-first, deterministic order. */
function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const coreOnly = args.includes('--core');
const pattern = args.find((a) => !a.startsWith('--')) ?? '';

let files = collect(testDir);
if (coreOnly) files = files.filter((f) => f.includes('model-quota'));
if (pattern) files = files.filter((f) => f.includes(pattern));

if (files.length === 0) {
  console.error('[test] no test files matched');
  process.exit(1);
}

console.log(`[test] node ${process.version} · ${files.length} file(s)`);
for (const f of files) console.log('  · ' + path.relative(root, f).replace(/\\/g, '/'));

const child = spawn(
  process.execPath,
  ['--test', ...files.map((f) => path.relative(root, f))],
  { cwd: root, stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
