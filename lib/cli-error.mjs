// A first-run problem the user can fix: the entry points print its one-line message and exit 1, no stack.
export class CliError extends Error {}

// Runs main(); a CliError becomes one line on stderr and exit code 1. Anything else is a bug and keeps its stack.
export async function runCli(main) {
  try {
    await main();
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
