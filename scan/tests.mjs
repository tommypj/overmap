// Tests fact: reads the test-results.json a project writes into one of its roots. Read-only; never throws.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { norm } from '../lib/paths.mjs';
import { maskSecrets } from '../lib/mask.mjs';

const isCount = (v) => Number.isInteger(v) && v >= 0;

export function readTestResults(roots, { now = Date.now, maxBytes = 65536 } = {}) {
  const at = new Date(now()).toISOString();
  let file = null;
  try {
    for (const root of roots ?? []) {
      const f = join(root, 'test-results.json');
      if (existsSync(f)) { file = f; break; }
    }
    if (!file) return { at, value: null };
    const name = norm(file);
    const err = (why) => ({ at, error: `${name}: ${why}` });
    if (statSync(file).size > maxBytes) return err('over 64 KiB');
    let j;
    try { j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return err('not JSON'); }
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return err('not JSON');
    if (j.at == null) return err('missing at');
    const when = new Date(j.at);
    if (typeof j.at !== 'string' || Number.isNaN(when.getTime())) return err('bad at');
    for (const k of ['passed', 'failed']) {
      if (j[k] == null) return err(`missing ${k}`);
      if (!isCount(j[k])) return err(`${k} must be a non-negative integer`);
    }
    if (j.skipped != null && !isCount(j.skipped)) return err('skipped must be a non-negative integer');
    if (j.durationMs != null && !(typeof j.durationMs === 'number' && Number.isFinite(j.durationMs) && j.durationMs >= 0)) return err('durationMs must be a non-negative number');
    const skipped = j.skipped ?? null;
    return {
      at,
      value: {
        file: name, at: j.at, passed: j.passed, failed: j.failed, skipped,
        total: isCount(j.total) ? j.total : j.passed + j.failed + (skipped ?? 0),
        durationMs: j.durationMs ?? null,
        command: typeof j.command === 'string' ? maskSecrets(j.command).slice(0, 200) : null,
      },
    };
  } catch (e) {
    return { at, error: `${file ? norm(file) : 'test-results.json'}: ${e?.message ?? e}` };
  }
}
