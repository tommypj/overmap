// Pure builders for test-results.json (the file scan/tests.mjs reads).
// Shape: { at, passed, failed, skipped, total, durationMs, command }.

const nonNeg = (n) => (Number.isInteger(n) && n >= 0 ? n : null);

export function buildResult({ passed, failed, skipped = null, total = null, durationMs = null, command = null, at = new Date().toISOString() }) {
  const p = nonNeg(passed), f = nonNeg(failed);
  if (p == null || f == null) throw new Error('passed and failed must be non-negative integers');
  const s = skipped == null ? null : nonNeg(skipped);
  const out = { at, passed: p, failed: f };
  if (s != null) out.skipped = s;
  const t = total == null ? p + f + (s ?? 0) : nonNeg(total);
  if (t != null) out.total = t;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) out.durationMs = Math.round(durationMs);
  if (typeof command === 'string' && command.trim()) out.command = command.trim().slice(0, 200);
  return out;
}

// node:test `test:summary` event data: { counts: { passed, failed, skipped, todo, cancelled, tests }, duration_ms }.
export function fromNodeSummary(data, extra = {}) {
  const c = data?.counts ?? {};
  return buildResult({
    passed: c.passed ?? 0,
    failed: (c.failed ?? 0) + (c.cancelled ?? 0),
    skipped: (c.skipped ?? 0) + (c.todo ?? 0),
    total: c.tests ?? null,
    durationMs: data?.duration_ms ?? null,
    ...extra,
  });
}

// jest / vitest `--json` output.
export function fromJestJson(obj, extra = {}) {
  if (!obj || typeof obj !== 'object' || !Number.isInteger(obj.numPassedTests)) throw new Error('not a jest/vitest JSON report (numPassedTests missing)');
  const ends = (obj.testResults ?? []).map((t) => t.endTime).filter((n) => typeof n === 'number');
  const start = typeof obj.startTime === 'number' ? obj.startTime : null;
  const durationMs = start != null && ends.length ? Math.max(...ends) - start : null;
  return buildResult({
    passed: obj.numPassedTests,
    failed: obj.numFailedTests ?? 0,
    skipped: (obj.numPendingTests ?? 0) + (obj.numTodoTests ?? 0),
    total: obj.numTotalTests ?? null,
    durationMs,
    at: start != null ? new Date(start).toISOString() : undefined,
    ...extra,
  });
}

// JUnit XML (pytest --junitxml, and most runners' junit reporters): sums every <testsuite> element.
export function fromJunitXml(text, extra = {}) {
  if (typeof text !== 'string' || !/<testsuite[\s>]/.test(text)) throw new Error('not a JUnit XML report (<testsuite> missing)');
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  let tests = 0, failures = 0, errors = 0, skipped = 0, seconds = 0, when = null;
  for (const m of text.matchAll(/<testsuite\b[^>]*>/g)) {
    const tag = m[0];
    tests += num(attr(tag, 'tests')); failures += num(attr(tag, 'failures')); errors += num(attr(tag, 'errors'));
    skipped += num(attr(tag, 'skipped')); seconds += num(attr(tag, 'time'));
    const ts = attr(tag, 'timestamp');
    if (ts && !when) { const d = new Date(ts); if (!Number.isNaN(d.getTime())) when = d.toISOString(); }
  }
  const failed = failures + errors;
  return buildResult({ passed: Math.max(0, tests - failed - skipped), failed, skipped, total: tests, durationMs: seconds * 1000, at: when ?? undefined, ...extra });
}

export const FORMATS = { jest: fromJestJson, vitest: fromJestJson, junit: fromJunitXml };

export function serialize(result) { return JSON.stringify(result) + '\n'; }
