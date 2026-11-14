import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, hostOk } from '../server/auth.mjs';

const config = { allowedLogin: 'me@example.com' };
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
const tn = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': 'me@example.com' };

test('loopback without proxy headers is laptop (all loopback forms)', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(classify(req(a), config), 'laptop');
});

test('loopback with https proto and the allowed login is tailnet (case/space insensitive)', () => {
  assert.equal(classify(req('127.0.0.1', tn), config), 'tailnet');
  assert.equal(classify(req('::1', { ...tn, 'tailscale-user-login': '  Me@Example.com ' }), config), 'tailnet');
});

test('allowed login without https proto is null', () => {
  const { 'x-forwarded-proto': _p, ...h } = tn;
  assert.equal(classify(req('127.0.0.1', h), config), null);
  assert.equal(classify(req('127.0.0.1', { ...tn, 'x-forwarded-proto': 'http' }), config), null);
});

test('wrong or empty login is null', () => {
  assert.equal(classify(req('127.0.0.1', { ...tn, 'tailscale-user-login': 'evil@example.com' }), config), null);
  assert.equal(classify(req('127.0.0.1', { ...tn, 'tailscale-user-login': '' }), config), null);
});

test('loopback with x-forwarded-for but no login is null (cannot pose as laptop)', () => {
  assert.equal(classify(req('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' }), config), null);
  assert.equal(classify(req('127.0.0.1', { 'x-forwarded-host': 'x' }), config), null);
});

test('loopback with login but no x-forwarded headers is null (not laptop)', () => {
  assert.equal(classify(req('127.0.0.1', { 'tailscale-user-login': 'me@example.com' }), config), null);
});

test('array or mixed-case login header never classifies as laptop', () => {
  assert.equal(classify(req('127.0.0.1', { 'tailscale-user-login': ['a@example.com'] }), config), null);
  assert.equal(classify(req('127.0.0.1', { 'tailscale-user-login': ['me@example.com'], 'x-forwarded-proto': 'https' }), config), null);
  assert.equal(classify(req('127.0.0.1', { 'Tailscale-User-Login': 'whoever@example.com' }), config), null);
  assert.equal(classify(req('127.0.0.1', { 'X-Forwarded-For': '1.2.3.4' }), config), null);
});

test('non-loopback source is null even with perfect headers', () => {
  assert.equal(classify(req('192.168.1.5'), config), null);
  assert.equal(classify(req('100.64.0.7', tn), config), null);
  assert.equal(classify(req(undefined), config), null);
  assert.equal(classify({ headers: {} }, config), null);
});

test('missing or empty allowedLogin never grants tailnet', () => {
  assert.equal(classify(req('127.0.0.1', { ...tn, 'tailscale-user-login': '' }), { allowedLogin: '' }), null);
  assert.equal(classify(req('127.0.0.1', tn), {}), null);
});

test('hostOk accepts loopback hosts and refuses everything else', () => {
  const h = (host) => ({ headers: host === undefined ? {} : { host } });
  assert.equal(hostOk(h('127.0.0.1:3210')), true);
  assert.equal(hostOk(h('localhost:3210')), true);
  assert.equal(hostOk(h('evil.example:3210')), false);
  assert.equal(hostOk(h('127.0.0.1:9999')), false);
  assert.equal(hostOk(h(undefined)), false);
});
test('hostOk accepts the configured proxy host only', () => {
  assert.ok(hostOk({ headers: { host: 'box.tail0000.ts.net' } }, 3210, 'box.tail0000.ts.net')); // privacy-ok
  assert.ok(!hostOk({ headers: { host: 'box.tail0000.ts.net' } }, 3210, null)); // privacy-ok
  assert.ok(hostOk({ headers: { host: '127.0.0.1:3210' } }, 3210, null));
});
test('empty allowedLogin never grants tailnet', () => {
  assert.equal(classify(req('127.0.0.1', tn), { allowedLogin: '' }), null);
});
