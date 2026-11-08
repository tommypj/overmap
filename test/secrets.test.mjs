import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAcl, getSecret, secretStatus, secretsHealth, _resetSecretsCache } from '../lib/secrets.mjs';

function tmpFile(json, grant) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-sec-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: 'ignore' });
  if (grant) execFileSync('icacls', [file, '/grant', grant], { stdio: 'ignore' });
  return { dir, file };
}

test('missing file: undefined value and health missing', () => {
  _resetSecretsCache();
  const file = join(tmpdir(), 'cockpit-nope', 'secrets.json');
  assert.equal(getSecret('A', file), undefined);
  const { cachedAt, ...rest } = secretsHealth(file);
  assert.deepEqual(rest, { file: 'missing', extra: [] });
  assert.ok(cachedAt);
  assert.deepEqual(secretStatus(['A'], file), { A: 'missing' });
});

test('protected file: ok, values returned, _meta ignored, status reported', () => {
  _resetSecretsCache();
  const { dir, file } = tmpFile({ _meta: { note: 'x' }, A: 'va', B: '' });
  try {
    assert.deepEqual(checkAcl(file), { ok: true, extra: [] });
    assert.equal(getSecret('A', file), 'va');
    assert.equal(getSecret('_meta', file), undefined);
    assert.equal(getSecret('NOPE', file), undefined);
    assert.equal(secretsHealth(file).file, 'ok');
    assert.deepEqual(secretStatus(['A', 'B', 'C', '_meta'], file), { A: 'set', B: 'missing', C: 'missing', _meta: 'missing' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extra principal: unprotected, extras listed, no values released', () => {
  _resetSecretsCache();
  const { dir, file } = tmpFile({ A: 'va' }, 'Everyone:R');
  try {
    const r = checkAcl(file);
    assert.equal(r.ok, false);
    assert.ok(r.extra.some((p) => /everyone/i.test(p)), JSON.stringify(r));
    assert.equal(getSecret('A', file), undefined);
    const h = secretsHealth(file);
    assert.equal(h.file, 'unprotected');
    assert.ok(h.extra.length > 0);
    assert.deepEqual(secretStatus(['A'], file), { A: 'missing' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkAcl passes for forward-slash and space-containing path spellings', () => {
  _resetSecretsCache();
  const { dir, file } = tmpFile({ A: 'va' });
  const spaced = mkdtempSync(join(tmpdir(), 'cockpit sec '));
  const spacedFile = join(spaced, 'secrets.json');
  try {
    assert.deepEqual(checkAcl(file.replaceAll('\\', '/')), { ok: true, extra: [] });
    writeFileSync(spacedFile, '{}');
    execFileSync('icacls', [spacedFile, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: 'ignore' });
    assert.deepEqual(checkAcl(spacedFile.replaceAll('\\', '/')), { ok: true, extra: [] });
    assert.equal(secretsHealth(spacedFile.replaceAll('\\', '/')).file, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(spaced, { recursive: true, force: true }); }
});

test('prototype keys are never secrets; cachedAt is set', () => {
  _resetSecretsCache();
  const { dir, file } = tmpFile({ A: 'va' });
  try {
    assert.equal(getSecret('constructor', file), undefined);
    assert.equal(getSecret('__proto__', file), undefined);
    assert.deepEqual(secretStatus(['toString', 'hasOwnProperty'], file), { toString: 'missing', hasOwnProperty: 'missing' });
    const h = secretsHealth(file);
    assert.ok(!Number.isNaN(Date.parse(h.cachedAt)), JSON.stringify(h));
    assert.ok(secretsHealth(join(tmpdir(), 'cockpit-nope2', 's.json')).cachedAt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed JSON in a protected file: unreadable, never throws', () => {
  _resetSecretsCache();
  const { dir, file } = tmpFile('{ not json');
  try {
    assert.equal(getSecret('A', file), undefined);
    assert.equal(secretsHealth(file).file, 'unreadable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the cache re-reads when the file changes (mtime or size) and updates cachedAt', async () => {
  _resetSecretsCache();
  const { dir, file } = tmpFile({ A: 'one' });
  try {
    assert.equal(getSecret('A', file), 'one');
    const first = secretsHealth(file).cachedAt;
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(file, JSON.stringify({ A: 'two-longer' }));
    assert.equal(getSecret('A', file), 'two-longer');
    assert.notEqual(secretsHealth(file).cachedAt, first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
