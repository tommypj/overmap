// Required-field readers for connector parse(): a missing field means the upstream shape changed.
export function need(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in cur) || cur[k] == null) throw new Error(`missing ${path} in response`);
    cur = cur[k];
  }
  return cur;
}
export function needNum(obj, path) {
  const v = need(obj, path);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`missing ${path} (not a number)`);
  return v;
}
export function needArr(obj, path) {
  const v = need(obj, path);
  if (!Array.isArray(v)) throw new Error(`missing ${path} (not a list)`);
  return v;
}
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Registry entries with a connectors.<id> block become targets; `pick` copies the fields the connector needs.
export function registryTargets(registry, id, pick) {
  const out = [];
  for (const [project, entry] of registry) {
    const cfg = entry.connectors?.[id];
    if (cfg) out.push({ ...pick(cfg), project }); // registry key last: a connector field can never overwrite it
  }
  return out;
}
