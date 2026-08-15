import { resolve } from "node:path";
import { parseArgs, type ParsedArgs } from "./args.js";
import { HELP_TEXT } from "./help.js";
import { readVersion } from "./version.js";

/** Sinks and ambient state the CLI needs, injectable so tests stay hermetic. */
export interface CliContext {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  version: string;
}

/** Exit code used when the arguments cannot be parsed. */
export const EXIT_USAGE = 2;

export function defaultContext(): CliContext {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    cwd: process.cwd(),
    version: readVersion(),
  };
}

/**
 * Runs the CLI for the given arguments and returns the process exit code.
 *
 * Every subcommand is still a stub: it reports the input it would act on
 * instead of doing the work.
 */
export function runCli(
  argv: readonly string[],
  context: CliContext = defaultContext(),
): number {
  const parsed = parseArgs(argv);
  return dispatch(parsed, context);
}

function dispatch(parsed: ParsedArgs, context: CliContext): number {
  const { out, err } = context;

  switch (parsed.kind) {
    case "help":
      out(HELP_TEXT.trimEnd());
      return 0;

    case "version":
      out(context.version);
      return 0;

    case "proxy":
      out("mode: proxy");
      out(`command: ${parsed.command}`);
      out(`args: ${formatArgs(parsed.args)}`);
      out("(not implemented yet — the server would be launched through the proxy)");
      return 0;

    case "verify":
    case "summary":
      out(`mode: ${parsed.kind}`);
      out(`path: ${parsed.path}`);
      out(`resolved: ${resolve(context.cwd, parsed.path)}`);
      out(`(not implemented yet — nothing was read from disk)`);
      return 0;

    case "error":
      err(`error: ${parsed.message}`);
      err("");
      err(HELP_TEXT.trimEnd());
      return EXIT_USAGE;
  }
}

/** Renders an argument list readably, making empty entries visible. */
function formatArgs(args: readonly string[]): string {
  if (args.length === 0) return "(none)";
  return args.map((arg) => JSON.stringify(arg)).join(" ");
}
