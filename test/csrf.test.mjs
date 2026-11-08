import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokens } from '../lib/csrf.mjs';

function mk() { let t = 0; const tk = createTokens({ now: () => t }); return { tk, adv: (ms) => { t += ms; } }; }

test('issue/check: distinct, class+login bound, expires', () => {
  const { tk, adv } = mk();
  const a = tk.issue('laptop', null), b = tk.issue('laptop', null);
  assert.notEqual(a.token, b.token);
  assert.equal(tk.check(a.token, 'laptop', null), true);
  assert.equal(tk.check(a.token, 'tailnet', null), false);
  assert.equal(tk.check('nope', 'laptop', null), false);
  const c = tk.issue('tailnet', 'a@example.com');
  assert.equal(tk.check(c.token, 'tailnet', 'a@example.com'), true);
  assert.equal(tk.check(c.token, 'tailnet', 'x@example.com'), false);
  adv(600_001);
  assert.equal(tk.check(a.token, 'laptop', null), false);
});

test('nonce: single use, bound, short-lived, per token', () => {
  const { tk, adv } = mk();
  const A = tk.issue('laptop', null), B = tk.issue('laptop', null);
  const n = tk.issueNonce(A.token, 'run|p|a|o');
  assert.equal(tk.consumeNonce(A.token, n, 'run|p|a|o'), true);
  assert.equal(tk.consumeNonce(A.token, n, 'run|p|a|o'), false);
  const n2 = tk.issueNonce(A.token, 'run|p|a|o');
  assert.equal(tk.consumeNonce(A.token, n2, 'run|p|a|other'), false);
  const n3 = tk.issueNonce(A.token, 'x');
  assert.equal(tk.consumeNonce(B.token, n3, 'x'), false);
  const n4 = tk.issueNonce(A.token, 'x');
  adv(60_001);
  assert.equal(tk.consumeNonce(A.token, n4, 'x'), false);
});

test('nonce needs a live parent token', () => {
  const { tk, adv } = mk();
  assert.equal(tk.issueNonce('unknown', 'x'), null);
  const A = tk.issue('laptop', null);
  const n = tk.issueNonce(A.token, 'x');
  adv(600_001);
  assert.equal(tk.consumeNonce(A.token, n, 'x'), false);
  assert.equal(tk.issueNonce(A.token, 'x'), null);
});

test('expired entries are pruned on issue', () => {
  const { tk, adv } = mk();
  for (let i = 0; i < 1000; i++) tk.issue('laptop', null);
  adv(700_000);
  tk.issue('laptop', null);
  assert.equal(tk.size(), 1);
});

test('the token map is capped at 1000: the oldest goes first', () => {
  const { tk } = mk();
  const first = tk.issue('laptop', null).token;
  for (let i = 0; i < 1000; i++) tk.issue('laptop', null);
  assert.ok(tk.size() <= 1000);
  assert.equal(tk.check(first, 'laptop', null), false);
});
