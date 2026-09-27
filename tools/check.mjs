#!/usr/bin/env node
// tools/check.mjs — static checks for dsh-key-rotation.
//
// The published package declares `npm run check` → `node tools/check.mjs`.
// This restores that entry point with no dependency: syntax-check every module
// with the running Node, then verify the import graph resolves and that the
// plugin's public entry module exports what package.json promises.
//
// It deliberately does NOT try to import lib/index.js: that module requires the
// cordis runtime and the @deepseek-ai peer dependencies, which are provided by
// the host rather than by this package.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libDir = path.join(root, 'lib');

const failures = [];
const note = (msg) => console.log('  ' + msg);

/** Every .js file under lib/, sorted. */
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = jsFiles(libDir);
console.log(`[check] syntax: ${files.length} module(s)`);
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) failures.push(`${rel}: ${(res.stderr || '').trim()}`);
}
if (failures.length === 0) note('all modules parse');

// Relative imports must point at a file that exists. A typo here would only
// surface at runtime, in the host, as a failed plugin load.
console.log('[check] relative import graph');
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"](\.[^'"]+)['"]/g;
let missing = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const match of src.matchAll(IMPORT_RE)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!existsSync(target)) {
      failures.push(`${path.relative(root, file)}: unresolved import '${match[1]}'`);
      missing++;
    }
  }
}
if (missing === 0) note('every relative import resolves');

// Only the entry points package.json actually promises are required here. The
// relative-import pass above already proves every module a file imports exists,
// which covers feature modules without hardcoding their names.
console.log('[check] required entry points');
for (const required of ['lib/index.js', 'lib/client.js']) {
  if (!existsSync(path.join(root, required))) failures.push(`missing ${required}`);
}
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  if (target.startsWith('./') && !existsSync(path.join(root, target))) {
    failures.push(`package.json exports["${key}"] -> ${target} does not exist`);
  }
}
if (failures.length === 0) note('entry points and exports are present');

if (failures.length > 0) {
  console.error('\n[check] FAILED');
  for (const f of failures) console.error('  ✖ ' + f);
  process.exit(1);
}
console.log('\n[check] OK');
