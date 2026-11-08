#!/usr/bin/env node
// Convert a runner's own report into test-results.json for the project cockpit.
//
//   node <overmap>/tools/test-results.mjs vitest .vitest.json
//   node <overmap>/tools/test-results.mjs jest   jest-report.json
//   node <overmap>/tools/test-results.mjs junit  junit.xml --command "pytest"
//
// Run mode: run the test command first, then convert its report, and exit with the command's own exit code:
//
//   node <overmap>/tools/test-results.mjs run vitest %TEMP%/t.json -- npm run test:unit -- --reporter=default --reporter=json --outputFile=%TEMP%/t.json
//
// `npm`, `npx` and `node` as the first word resolve to the npm/npx CLI next to this node (no shell involved).
//
// Options: --out <path> (default ./test-results.json), --command <text> (recorded, cut to 200 chars).
// Exit 0 when the file was written, 2 on bad input. Nothing but counts is read from the report.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FORMATS, serialize } from './test-results-lib.mjs';

export function parseArgs(argv) {
  const out = { run: false, format: null, file: null, out: 'test-results.json', command: null, cmd: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.cmd = argv.slice(i + 1); break; }
    if (a === '--out') out.out = argv[++i] ?? out.out;
    else if (a === '--command') out.command = argv[++i] ?? null;
    else rest.push(a);
  }
  if (rest[0] === 'run') { out.run = true; rest.shift(); }
  [out.format, out.file] = rest;
  return out;
}

// `npm`/`npx` become the CLI scripts shipped next to the running node; `node` becomes this node.
export function resolveCommand(cmd, execPath = process.execPath) {
  const [head, ...args] = cmd;
  if (head === 'node') return [execPath, ...args];
  if (head === 'npm' || head === 'npx') {
    const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', `${head}-cli.js`);
    if (!existsSync(cli)) throw new Error(`${head}-cli.js not found next to node`);
    return [execPath, cli, ...args];
  }
  return cmd;
}

export function convert(format, text, extra = {}) {
  const fn = FORMATS[format];
  if (!fn) throw new Error(`unknown format "${format}" (use ${Object.keys(FORMATS).join(', ')})`);
  return fn(format === 'junit' ? text : JSON.parse(text), extra);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.format || !a.file || (a.run && !a.cmd.length)) {
    process.stderr.write('usage: test-results.mjs [run] <jest|vitest|junit> <report-file> [--out test-results.json] [--command "<text>"] [-- <test command...>]\n');
    return 2;
  }
  let exit = 0;
  if (a.run) {
    let cmd;
    try { cmd = resolveCommand(a.cmd); } catch (e) { process.stderr.write(`test-results: ${e.message}\n`); return 2; }
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: false });
    if (r.error) { process.stderr.write(`test-results: ${r.error.message}\n`); return 2; }
    exit = r.status ?? 1;
    if (!a.command) a.command = a.cmd.join(' ');
  }
  try {
    const result = convert(a.format, readFileSync(resolve(a.file), 'utf8').replace(/^\uFEFF/, ''), a.command ? { command: a.command } : {});
    writeFileSync(resolve(a.out), serialize(result));
    process.stdout.write(`${a.out}: ${result.passed} passed, ${result.failed} failed${result.skipped ? `, ${result.skipped} skipped` : ''}\n`);
    return exit;
  } catch (e) {
    process.stderr.write(`test-results: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${resolve(process.argv[1]).replaceAll('\\', '/')}`).href) process.exit(main());
