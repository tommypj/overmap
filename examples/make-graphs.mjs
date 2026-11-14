// Regenerates the sample code graphs: examples/sample/<project>/graphify-out/graph.json (storefront gets none).
// Deterministic: a seeded PRNG, so the same script always writes the same bytes. Run by hand only:
//   node examples/make-graphs.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELATIONS = ['calls', 'imports', 'uses'];

const SPECS = [
  { id: 'shop-api', seed: 11, nodes: 140, modules: ['cart', 'checkout', 'catalog', 'orders', 'auth'] },
  { id: 'api-worker', seed: 23, nodes: 96, modules: ['worker', 'queue', 'mailer', 'sync'] },
  { id: 'mobile-app', seed: 37, nodes: 118, modules: ['auth', 'catalog', 'cart', 'offline'] },
  { id: 'docs-site', seed: 41, nodes: 64, modules: ['pages', 'search', 'nav'] },
  { id: 'ops-tool', seed: 53, nodes: 82, modules: ['sync', 'reports', 'auth', 'mailer'] },
];

// mulberry32: a small seeded PRNG returning floats in [0, 1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildGraph({ seed, nodes, modules }) {
  const rand = mulberry32(seed);
  const pick = (n) => Math.floor(rand() * n);
  const perModule = modules.map(() => 0);
  const list = [];
  for (let i = 0; i < nodes; i++) {
    const c = i < modules.length ? i : pick(modules.length); // every module gets at least one node
    const name = modules[c];
    const j = perModule[c]++;
    list.push({
      id: `n${String(i).padStart(3, '0')}`,
      label: `${name}_${j}`,
      community: c,
      community_name: name,
      source_file: `${name}/${name}_${j}.ts`,
      file_type: 'code',
    });
  }
  const byModule = modules.map(() => []);
  const all = list.map((_, i) => i);
  list.forEach((n, i) => byModule[n.community].push(i));

  const edges = [];
  const seen = new Set();
  for (let i = 0; i < nodes; i++) {
    const out = 1 + pick(3);
    for (let k = 0; k < out; k++) {
      const pool = rand() < 0.8 ? byModule[list[i].community] : all;
      const t = pool[pick(pool.length)];
      const key = `${i}>${t}`;
      if (t === i || seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: list[i].id, target: list[t].id, relation: RELATIONS[pick(RELATIONS.length)], weight: 1 + pick(3) });
    }
  }
  return { directed: true, multigraph: false, graph: {}, nodes: list, edges };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  for (const spec of SPECS) {
    const dir = join(HERE, 'sample', spec.id, 'graphify-out');
    mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(buildGraph(spec), null, 1).replace(/\r?\n/g, '\r\n') + '\r\n';
    writeFileSync(join(dir, 'graph.json'), text, 'utf8');
    console.log(`${spec.id}: ${spec.nodes} nodes, ${spec.modules.length} communities`);
  }
}
