// The lowest Node that runs Overmap: 22.13, where node:sqlite needs no flag. Imported first by the entry
// points (serve.mjs, scan.mjs), so an older Node gets one line and exit 1 before anything else loads.
export const NODE_FLOOR = '22.13.0';

export function meetsFloor(version, floor = NODE_FLOOR) {
  const a = String(version).replace(/^v/, '').split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  }
  return true;
}

if (!meetsFloor(process.versions.node)) {
  console.error(`Overmap needs Node ${NODE_FLOOR.replace(/\.0$/, '')} or newer (this is ${process.versions.node}). Install a newer Node, then run the command again.`);
  process.exit(1);
}
