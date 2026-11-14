// Pure map model: turns data/projects.json into map nodes and edges.
// Browser-safe: no DOM, no Node imports.

const PARKED = ['archived', 'terminated', 'parked'];
const isParked = (p) => PARKED.includes(p.status);
const hasGraph = (p) => !!(p.graph && p.graph.value);

export function mapModel(data, { expanded = new Set(), hideParked = true } = {}) {
  const projects = (data.projects || []).filter((p) => !(hideParked && isParked(p)));
  const groupOf = (p) => p.group || null;
  const collapsed = (g) => g && !expanded.has(g);

  const nodes = [];
  const groupSizes = new Map();
  for (const p of projects) {
    const g = groupOf(p);
    if (collapsed(g)) groupSizes.set(g, (groupSizes.get(g) || 0) + 1);
  }
  const emitted = new Set();
  for (const p of projects) {
    const g = groupOf(p);
    if (collapsed(g)) {
      const id = `group:${g}`;
      if (!emitted.has(id)) {
        emitted.add(id);
        nodes.push({ id, kind: 'group', label: g, size: groupSizes.get(g), graph: false });
      }
    } else {
      nodes.push({ id: p.id, kind: 'project', label: p.name, size: 1, status: p.status, group: g || undefined, graph: hasGraph(p) });
      emitted.add(p.id);
    }
  }
  for (const s of data.services || []) {
    nodes.push({ id: `service:${s.id}`, kind: 'service', label: s.name, size: s.count ?? 1, graph: false });
    emitted.add(`service:${s.id}`);
  }

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const resolve = (id) => {
    const p = projectById.get(id);
    if (!p) return null;
    const g = groupOf(p);
    return collapsed(g) ? `group:${g}` : id;
  };

  const merged = new Map();
  for (const e of data.edges || []) {
    const isService = e.kind === 'uses';
    const a = resolve(e.a);
    const b = isService ? `service:${e.b}` : resolve(e.b);
    if (!a || !b || a === b || !emitted.has(a) || !emitted.has(b)) continue;
    const key = `${e.kind}\u0000${[a, b].sort().join('\u0000')}`;
    const hit = merged.get(key);
    if (hit) hit.weight += 1;
    else merged.set(key, { a, b, kind: e.kind, weight: 1 });
  }
  return { nodes, edges: [...merged.values()] };
}
