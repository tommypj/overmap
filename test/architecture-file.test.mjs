import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeArchitectureFile } from '../scan/assemble.mjs';

test('a null architectureFile writes nothing and reports not-configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overmap-arch-'));
  const before = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(writeArchitectureFile(null, '# ARCHITECTURE\n'), 'not-configured');
    assert.equal(writeArchitectureFile('', '# ARCHITECTURE\n'), 'not-configured');
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(fs.existsSync(path.join(dir, 'null')), false);
  } finally {
    process.chdir(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a configured architectureFile is written once, then reports unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overmap-arch-'));
  const file = path.join(dir, 'ARCHITECTURE.md');
  try {
    assert.equal(writeArchitectureFile(file, '# ARCHITECTURE\n'), 'written');
    assert.equal(fs.readFileSync(file, 'utf8'), '# ARCHITECTURE\n');
    assert.equal(writeArchitectureFile(file, '# ARCHITECTURE\n'), 'unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
