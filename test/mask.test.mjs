import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from '../lib/mask.mjs';

test('maskSecrets masks a bearer token and leaves plain text', () => {
  assert.notEqual(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
  assert.equal(maskSecrets('hello'), 'hello');
});
