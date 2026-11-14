// Graph fact: summarises <home>/graphify-out/graph.json for the scan. Read-only; never throws.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readGraph, summarise } from '../lib/graph.mjs';
import { norm } from '../lib/paths.mjs';

const DEFAULT_MAX_BYTES = 67108864;

export function graphFact(home, { maxBytes = DEFAULT_MAX_BYTES, now = Date.now } = {}) {
  const at = new Date(now()).toISOString();
  const file = join(home, 'graphify-out', 'graph.json');
  if (!existsSync(file)) return { at, value: null };
  try {
    return { at, value: summarise(readGraph(file, { maxBytes })) };
  } catch (e) {
    return { at, value: null, error: `${norm(file)}: ${e?.message ?? String(e)}` };
  }
}
