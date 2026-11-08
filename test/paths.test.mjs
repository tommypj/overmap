import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, isUnder, SECRET_NAME, DEP_DIRS } from '../lib/paths.mjs';

test('norm normalises slashes, drive letter, trailing slash', () => {
  const B = String.fromCharCode(92);
  assert.equal(norm(['d:', 'Projects', 'x', ''].join(B)), 'D:/Projects/x'); // privacy-ok
});
test('norm collapses repeated slashes but keeps UNC prefix', () => {
  assert.equal(norm('D://Sample app//A'), 'D:/Sample app/A'); // privacy-ok
  assert.equal(norm('//srv//share//x/'), '//srv/share/x');
});
test('isUnder is case-insensitive and boundary-aware', () => {
  assert.equal(isUnder('D:/projects/foo/a', 'd:/PROJECTS/foo'), true); // privacy-ok
  assert.equal(isUnder('D:/projects/Foobar', 'D:/projects/Foo'), false); // privacy-ok
  assert.equal(isUnder('D:/projects/Foo', 'D:/projects/Foo'), true); // privacy-ok
});
test('SECRET_NAME', () => {
  for (const n of ['.env', '.env.local', 'id_rsa.pub', 'client_secret_123.json', 'x.bak-2026', 'x.bak', 'x.bak.1', 'config.json.bak-2026-10-21', 'a.jks', 'a.keystore', 'a.kdbx', 'credentials.json', 'credentials-prod.json', 'service-account.json', 'service-account-x.json', '.npmrc', '.pgpass']) assert.ok(SECRET_NAME.test(n), n);
  for (const n of ['.env.example', '.env.sample', '.env.template', 'readme.md']) assert.ok(!SECRET_NAME.test(n), n);
});
test('DEP_DIRS', () => {
  assert.ok(DEP_DIRS.has('node_modules') && DEP_DIRS.has('graphify-out') && DEP_DIRS.has('.tmp-media'));
  assert.equal(DEP_DIRS.size, 16);
});
