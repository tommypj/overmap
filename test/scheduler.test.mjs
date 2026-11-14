import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScheduler } from '../serve.mjs';

const noTimer = () => ({ unref() {} });

test('a failing or hung scan runner resets the running flag', async () => {
  let calls = 0;
  const seen = [];
  const run = async (_cmd, _args, opts) => { calls++; seen.push(opts); throw new Error('boom'); };
  const s = startScheduler({ home: 'no-such-home' }, { run, setIntervalFn: noTimer, setTimeoutFn: noTimer });
  const origErr = console.error;
  console.error = () => {};
  try {
    await s.scan(false);
    assert.equal(s.isRunning(), false);
    await s.scan(true);
    assert.equal(calls, 2);
  } finally { console.error = origErr; s.stop(); }
  assert.equal(seen[0].timeout, 15 * 60 * 1000);
  assert.equal(seen[0].killSignal, 'SIGKILL');
});

test('overlapping scans are queued into one more run', async () => {
  let calls = 0;
  let release;
  const run = () => { calls++; return new Promise((r) => { release = r; }); };
  const s = startScheduler({ home: 'no-such-home' }, { run, setIntervalFn: noTimer, setTimeoutFn: noTimer });
  const origErr = console.error;
  console.error = () => {};
  try {
    const first = s.scan(false);
    await s.scan(false);
    assert.equal(calls, 1);
    release();
    await new Promise((r) => setImmediate(r));
    release();
    await first;
    assert.equal(calls, 2);
    assert.equal(s.isRunning(), false);
  } finally { console.error = origErr; s.stop(); }
});

test('two calls during one run produce exactly one extra run, with the stronger full flag', async () => {
  const seen = [];
  const rel = [];
  const run = (_c, args) => { seen.push(args.includes('--no-size')); return new Promise((r) => rel.push(r)); };
  const s = startScheduler({ home: 'no-such-home' }, { run, setIntervalFn: noTimer, setTimeoutFn: noTimer });
  const origErr = console.error;
  console.error = () => {};
  try {
    const first = s.scan(false);
    await s.scan(false);
    await s.scan(true);
    rel[0]();
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 2);
    rel[1]();
    await first;
    assert.deepEqual(seen, [true, false]); // light, then the queued full one (no --no-size)
    assert.equal(s.isRunning(), false);
  } finally { console.error = origErr; s.stop(); }
});
