// Pure reader and summariser for a graphify graph.json (NetworkX node-link JSON). No scan or server imports.
import { statSync, readFileSync } from 'node:fs';

const UNASSIGNED = 'unassigned';
const sid = (v) => String(v);
const commId = (v) => (v === undefined || v === null || v === '' ? UNASSIGNED : String(v));
const weightOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 1);

// Reads a graph file. Throws when it is over maxBytes (checked with statSync before reading) or is not a graph.
export function readGraph(file, { maxBytes }) {
  const size = statSync(file).size;
  if (size > maxBytes) throw new Error(`graph larger than ${maxBytes} bytes (raise graphMaxBytes in overmap.config.json)`);
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('graph.json is not valid JSON');
    throw e;
  }
  if (j === null || typeof j !== 'object' || !Array.isArray(j.nodes)) throw new Error('graph has no nodes array');
  const rawEdges = j.edges ?? j.links ?? [];
  if (!Array.isArray(rawEdges)) throw new Error('graph edges are not an array');

  const nodes = j.nodes.filter((n) => n && n.id !== undefined && n.id !== null).map((n) => {
    const community = commId(n.community);
    const name = community === UNASSIGNED ? UNASSIGNED : (typeof n.community_name === 'string' && n.community_name ? n.community_name : `community ${community}`);
    return {
      id: sid(n.id),
      label: typeof n.label === 'string' ? n.label : sid(n.id),
      community,
      communityName: name,
      file: typeof n.source_file === 'string' && n.source_file ? n.source_file : null,
    };
  });
  const known = new Set(nodes.map((n) => n.id));
  const edges = rawEdges
    .filter((e) => e && known.has(sid(e.source)) && known.has(sid(e.target)))
    .map((e) => ({
      source: sid(e.source),
      target: sid(e.target),
      relation: typeof e.relation === 'string' ? e.relation : null,
      weight: weightOf(e.weight),
    }));
  return { nodes, edges };
}

// Degree = in + out over all edges. Returns Map id -> degree.
function degrees(graph) {
  const d = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) { d.set(e.source, d.get(e.source) + 1); d.set(e.target, d.get(e.target) + 1); }
  return d;
}

const byDegreeThenId = (a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function summarise(graph, { topPerCommunity = 5, gods = 10 } = {}) {
  const deg = degrees(graph);
  const byComm = new Map();
  const commOf = new Map();
  for (const n of graph.nodes) {
    commOf.set(n.id, n.community);
    if (!byComm.has(n.community)) byComm.set(n.community, { id: n.community, name: n.communityName, nodes: [] });
    byComm.get(n.community).nodes.push(n);
  }
  const communities = [...byComm.values()]
    .map((c) => ({
      id: c.id,
      name: c.name,
      size: c.nodes.length,
      top: c.nodes.map((n) => ({ id: n.id, label: n.label, degree: deg.get(n.id) })).sort(byDegreeThenId).slice(0, topPerCommunity),
    }))
    .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const godNodes = graph.nodes
    .map((n) => ({ id: n.id, label: n.label, community: n.community, degree: deg.get(n.id) }))
    .sort(byDegreeThenId)
    .slice(0, gods);

  const pairs = new Map();
  for (const e of graph.edges) {
    const ca = commOf.get(e.source);
    const cb = commOf.get(e.target);
    if (ca === cb) continue;
    const [a, b] = ca < cb ? [ca, cb] : [cb, ca];
    const key = `${a}\0${b}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, weight: 0 });
    pairs.get(key).weight += e.weight;
  }
  const communityEdges = [...pairs.values()].sort((x, y) => y.weight - x.weight || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));

  return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, communities, gods: godNodes, communityEdges };
}

// One community's nodes (by degree, cut at maxNodes) and the edges among the kept nodes.
export function communityDetail(graph, communityId, { maxNodes = 500 } = {}) {
  const id = String(communityId);
  const deg = degrees(graph);
  const members = graph.nodes.filter((n) => n.community === id);
  const name = members[0]?.communityName ?? id;
  const sorted = members
    .map((n) => ({ id: n.id, label: n.label, degree: deg.get(n.id), file: n.file }))
    .sort(byDegreeThenId);
  const kept = sorted.slice(0, maxNodes);
  const keptIds = new Set(kept.map((n) => n.id));
  const edges = graph.edges
    .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, relation: e.relation }));
  return { community: { id, name }, nodes: kept, edges, truncated: sorted.length > maxNodes };
}
