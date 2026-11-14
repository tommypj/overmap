// Cockpit server: read-only API + static web on 127.0.0.1; Tailscale serve proxies it to the tailnet.
// Also owns the rescan schedule (15 min light, daily 04:00 full, never overlapping).
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { openDb } from './lib/db.mjs';
import { resolveHome, ensureHome } from './lib/home.mjs';
import { createSecrets } from './lib/secrets.mjs';
import { createHandler } from './server/router.mjs';
import { createRoutes } from './server/api.mjs';
import { CONNECTORS } from './connectors/index.mjs';
import { runConnector, EVERY_MS } from './lib/connector.mjs';
import { fetchJson } from './lib/http.mjs';
import { loadRegistry } from './registry.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// One secrets reader per instance: the routes and the connector scheduler share it.
export function createApp(config, env = process.env, extra = {}) {
  const { secrets: given, ...rest } = extra;
  const secrets = given ?? createSecrets(config.home);
  const routes = createRoutes({ config, env, secrets, getSecret: secrets.getSecret, ...rest });
  const server = createServer(createHandler({ config, port: config.port, routes }));
  server.on('close', routes.close);
  return server;
}

export function startScheduler(config, { run = promisify(execFile), setIntervalFn = setInterval, setTimeoutFn = setTimeout } = {}) {
  const dataFile = join(config.home, 'data', 'projects.json');
  let running = false;
  let queued = false, queuedFull = false; // a scan asked for during a run: one more follows it
  let db = null;

  function record() {
    try {
      const d = JSON.parse(readFileSync(dataFile, 'utf8'));
      db ??= openDb(join(config.home, 'data', 'overmap.db'));
      db.prepare('INSERT INTO scan_runs(at, seconds, projects) VALUES (?, ?, ?)').run(d.generatedAt, d.scanSeconds ?? null, d.projects?.length ?? 0);
    } catch (e) {
      console.error('scan_runs record failed:', e.message);
    }
  }

  async function scan(full) {
    if (running) { queued = true; queuedFull ||= !!full; return; }
    running = true;
    try {
      let f = full;
      for (;;) {
        await scanOnce(f);
        if (!queued) break;
        f = queuedFull; queued = false; queuedFull = false;
      }
    } finally {
      running = false;
    }
  }

  async function scanOnce(full) {
    const args = ['scan.mjs', '--home', config.home, ...(full ? [] : ['--no-size']), '--quiet'];
    try {
      await run('node', args, { cwd: HERE, windowsHide: true, timeout: 15 * 60 * 1000, killSignal: 'SIGKILL' });
      record();
    } catch (err) {
      console.error(`scan ${full ? 'full' : 'light'} failed:`, err.message);
    }
  }

  const timers = [setIntervalFn(() => scan(false), 15 * 60_000)];

  // Daily full scan at 04:00 local.
  function armDaily() {
    const next = new Date();
    next.setHours(4, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    timers.push(setTimeoutFn(() => { scan(true); armDaily(); }, next.getTime() - Date.now()));
  }
  armDaily();

  try {
    if (Date.now() - statSync(dataFile).mtimeMs > 20 * 60_000) timers.push(setTimeoutFn(() => scan(false), 30_000));
  } catch {
    timers.push(setTimeoutFn(() => scan(false), 30_000));
  }
  for (const t of timers) t?.unref?.();
  return { scan, isRunning: () => running, stop: () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); }) };
}

// Connector scheduler: one timer per connector, first run 60 s after start (5 s apart), targets serial,
// a connector never overlaps itself. Failures are recorded by runConnector; nothing here can crash the server.
export function startConnectorScheduler(config, {
  connectors = CONNECTORS, setIntervalFn = setInterval, setTimeoutFn = setTimeout,
  secret = createSecrets(config.home).getSecret, fetchJsonImpl = fetchJson, now = Date.now, db: injectedDb = null,
} = {}) {
  const dataFile = join(config.home, 'data', 'projects.json');
  const registryFile = join(config.home, 'registry.json');
  const running = new Set();
  const timers = [];
  let db = injectedDb;
  const ownsDb = injectedDb === null;

  async function tick(conn) {
    if (running.has(conn.id)) return;
    running.add(conn.id);
    try {
      db ??= openDb(join(config.home, 'data', 'overmap.db'));
      let registry;
      try { registry = loadRegistry(registryFile); } catch { registry = new Map(); }
      let projectsJson = {};
      try { projectsJson = JSON.parse(readFileSync(dataFile, 'utf8')); } catch { /* no scan yet */ }
      const ctx = { getSecret: secret, fetchJson: fetchJsonImpl, now };
      for (const target of conn.targets(registry, projectsJson)) {
        try { await runConnector(conn, target, ctx, db); } catch (e) { console.error(`connector ${conn.id}/${target.project}:`, e.message); }
      }
    } catch (e) {
      console.error(`connector ${conn.id} failed:`, e.message);
    } finally {
      running.delete(conn.id);
    }
  }

  connectors.forEach((conn, i) => {
    if (!EVERY_MS[conn.every]) { console.error(`connector ${conn.id}: unknown cadence ${conn.every}, skipped`); return; }
    const first = setTimeoutFn(() => {
      tick(conn);
      const t = setIntervalFn(() => tick(conn), EVERY_MS[conn.every]);
      t?.unref?.();
      timers.push(t);
    }, 60_000 + i * 5_000);
    first?.unref?.();
    timers.push(first);
  });
  return { tick, isRunning: (id) => running.has(id), stop: () => { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); if (ownsDb && db) { try { db.close(); } catch { /* closed */ } db = null; } } };
}

// Options: home (instance folder), port (overrides config.port), noSchedule (or OVERMAP_NO_SCHEDULE=1).
export function startServer({ home = resolveHome(), env = process.env, onError, port: portOverride, noSchedule: noScheduleOpt = false } = {}) {
  const loaded = loadConfig(home);
  const config = portOverride ? { ...loaded, port: portOverride } : loaded;
  const port = config.port;
  const noSchedule = noScheduleOpt || env.OVERMAP_NO_SCHEDULE === '1';
  const secrets = createSecrets(config.home);
  const scheduler = !noSchedule ? startScheduler(config) : null;
  const server = createApp(config, env, { secrets, ...(scheduler ? { rescan: (full) => scheduler.scan(full), isScanning: () => scheduler.isRunning() } : {}) });
  if (scheduler) server.on('close', scheduler.stop);
  server.on('error', (err) => {
    const msg = err.code === 'EADDRINUSE' ? `port ${port} in use, refusing to start` : `server error: ${err.message}`;
    console.error(msg);
    if (onError) onError(err, msg); else process.exit(2);
  });
  server.listen(port, '127.0.0.1', () => console.log(`dashboard on http://127.0.0.1:${port}`));
  if (!noSchedule) {
    const cs = startConnectorScheduler(config, { secret: secrets.getSecret });
    server.on('close', cs.stop);
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  const home = resolveHome();
  ensureHome(home);
  const i = process.argv.indexOf('--port');
  startServer({ home, port: i >= 0 ? Number(process.argv[i + 1]) || undefined : undefined, noSchedule: process.argv.includes('--no-schedule') });
}
