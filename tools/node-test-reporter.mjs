// node:test reporter that emits test-results.json for the project cockpit.
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=<overmap>/tools/node-test-reporter.mjs --test-reporter-destination=test-results.json "test/*.test.mjs"
//
// Node writes whatever this generator yields to its destination, so the file is the JSON itself.
// Counts come from the final `test:summary` event (Node 23+); older runtimes fall back to counting pass/fail events.
import { fromNodeSummary, buildResult, serialize } from './test-results-lib.mjs';

export default async function* cockpitReporter(source) {
  const started = Date.now();
  let summary = null;
  let passed = 0, failed = 0, skipped = 0;
  for await (const event of source) {
    switch (event.type) {
      case 'test:pass': if (event.data?.skip || event.data?.todo) skipped++; else passed++; break;
      case 'test:fail': failed++; break;
      case 'test:summary': if (!event.data?.file) summary = event.data; break;
      default: break;
    }
  }
  // execArgv holds `--test` and the runner flags; argv[1..] the files or globs. Reporter flags are noise.
  const command = ['node', ...process.execArgv, ...process.argv.slice(1)].filter((a) => !a.startsWith('--test-reporter')).join(' ');
  const result = summary
    ? fromNodeSummary(summary, { command })
    : buildResult({ passed, failed, skipped, durationMs: Date.now() - started, command });
  yield serialize(result);
}
