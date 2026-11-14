import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAcl, createSecrets } from '../lib/secrets.mjs';

const WIN = process.platform === 'win32';
const BS = String.fromCharCode(92);

// A home folder with secrets.json; on Windows the ACL is restricted to the current user (plus an optional extra grant).
function tmpHome(json, grant) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-sec-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  if (WIN) {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: 'ignore' });
    if (grant) execFileSync('icacls', [file, '/grant', grant], { stdio: 'ignore' });
  }
  return { dir, file };
}

// Fake stat for the POSIX branch: a file's mode cannot be set on Windows, so inject it.
const modeStat = (mode) => () => ({ mode });

test('missing file: undefined value and health missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-nope-'));
  try {
    const s = createSecrets(dir);
    assert.equal(s.getSecret('A'), undefined);
    const { cachedAt, ...rest } = s.health();
    assert.deepEqual(rest, { file: 'missing', ok: true, extra: [] });
    assert.ok(!Number.isNaN(Date.parse(cachedAt)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('posix health: mode 600 ok, 644 not ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-posix-'));
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ A: 'va' }));
  try {
    const good = createSecrets(dir, { platform: 'linux', statImpl: modeStat(0o100600) });
    assert.equal(good.getSecret('A'), 'va');
    assert.equal(good.health().file, 'ok');
    assert.equal(good.health().ok, true);

    const bad = createSecrets(dir, { platform: 'linux', statImpl: modeStat(0o100644) });
    assert.equal(bad.getSecret('A'), undefined);
    assert.equal(bad.health().file, 'unprotected');
    assert.equal(bad.health().ok, false);
    assert.deepEqual(bad.health().extra, ['mode 0644']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('protected file: ok, values returned, _meta ignored', () => {
  const { dir, file } = tmpHome({ _meta: { note: 'x' }, A: 'va', B: '' });
  try {
    const s = createSecrets(dir, WIN ? {} : { platform: 'linux', statImpl: modeStat(0o100600) });
    assert.equal(s.getSecret('A'), 'va');
    assert.equal(s.health().file, 'ok');
    assert.equal(s.getSecret('_meta'), undefined);
    assert.equal(s.getSecret('NOPE'), undefined);
    assert.equal(s.getSecret('B'), undefined);
    if (WIN) assert.deepEqual(checkAcl(file), { ok: true, extra: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extra principal: unprotected, extras listed, no values released', { skip: !WIN && 'Windows ACLs only' }, () => {
  const { dir, file } = tmpHome({ A: 'va' }, 'Everyone:R');
  try {
    const r = checkAcl(file);
    assert.equal(r.ok, false);
    assert.ok(r.extra.some((p) => /everyone/i.test(p)), JSON.stringify(r));
    const s = createSecrets(dir);
    assert.equal(s.getSecret('A'), undefined);
    const h = s.health();
    assert.equal(h.file, 'unprotected');
    assert.equal(h.ok, false);
    assert.ok(h.extra.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ACL check passes for forward-slash and space-containing home spellings', { skip: !WIN && 'Windows ACLs only' }, () => {
  const { dir } = tmpHome({ A: 'va' });
  const spaced = mkdtempSync(join(tmpdir(), 'cockpit sec '));
  try {
    assert.equal(createSecrets(dir.replaceAll(BS, '/')).health().file, 'ok');
    writeFileSync(join(spaced, 'secrets.json'), '{"A":"v"}');
    execFileSync('icacls', [join(spaced, 'secrets.json'), '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: 'ignore' });
    assert.equal(createSecrets(spaced.replaceAll(BS, '/')).getSecret('A'), 'v');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(spaced, { recursive: true, force: true }); }
});

test('prototype keys are never secrets; cachedAt is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-proto-'));
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ A: 'va' }));
  try {
    const s = createSecrets(dir, { platform: 'linux', statImpl: modeStat(0o100600) });
    assert.equal(s.getSecret('constructor'), undefined);
    assert.equal(s.getSecret('__proto__'), undefined);
    assert.equal(s.getSecret('toString'), undefined);
    assert.ok(!Number.isNaN(Date.parse(s.health().cachedAt)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed JSON in a protected file: unreadable, never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-bad-'));
  writeFileSync(join(dir, 'secrets.json'), '{ not json');
  try {
    const s = createSecrets(dir, { platform: 'linux', statImpl: modeStat(0o100600) });
    assert.equal(s.getSecret('A'), undefined);
    assert.equal(s.health().file, 'unreadable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the cache re-reads when the file changes and updates cachedAt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-cache-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify({ A: 'one' }));
  try {
    const s = createSecrets(dir, { platform: 'linux', statImpl: modeStat(0o100600) });
    assert.equal(s.getSecret('A'), 'one');
    const first = s.health().cachedAt;
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(file, JSON.stringify({ A: 'two-longer' }));
    assert.equal(s.getSecret('A'), 'two-longer');
    assert.notEqual(s.health().cachedAt, first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
