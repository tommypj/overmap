// Plan readers: each detects a plan format in a project home and reads it into
// Plan = { source, updatedAt, percent, milestones: [{ id, title, due, percent, sprints: [{ id, title, due, percent, items }] }] }.
// PLAN.md (master-plan) wins over checkbox-docs when both exist.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import masterPlan from './master-plan.mjs';
import checkboxDocs, { planFiles } from './checkbox-docs.mjs';

export const READERS = [masterPlan, checkboxDocs];

export function pickReader(home) {
  return READERS.find((r) => r.detect(home)) ?? null;
}

// mtime (ms) of PLAN.md when present, else the newest plan doc, else null.
export function planFileMtime(home) {
  const master = join(home, 'PLAN.md');
  if (existsSync(master)) return statSync(master).mtimeMs;
  let newest = null;
  for (const f of planFiles(home)) {
    const t = statSync(f).mtimeMs;
    if (newest === null || t > newest) newest = t;
  }
  return newest;
}

// The plan file itself: PLAN.md when present, else the newest plan doc, else null.
export function planFilePath(home) {
  const master = join(home, 'PLAN.md');
  if (existsSync(master)) return master;
  let best = null;
  let bestT = null;
  for (const f of planFiles(home)) {
    const t = statSync(f).mtimeMs;
    if (bestT === null || t > bestT) { best = f; bestT = t; }
  }
  return best;
}
