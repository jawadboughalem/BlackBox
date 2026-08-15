import { resolve } from "node:path";
import { parseArgs, type ParsedArgs } from "./args.js";
import { HELP_TEXT } from "./help.js";
import { runProxy } from "./proxy.js";
import { readVersion } from "./version.js";

/** Streams and ambient state the CLI needs, injectable so tests stay hermetic. */
export interface CliContext {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  cwd: string;
  version: string;
}

/** Exit code used when the arguments cannot be parsed. */
export const EXIT_USAGE = 2;

export function defaultContext(): CliContext {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    version: readVersion(),
  };
}

/**
 * Runs the CLI for the given arguments and resolves with the process exit code.
 *
 * `verify` and `summary` are still stubs that report the input they would act
 * on; proxy mode is live.
 */
export function runCli(
  argv: readonly string[],
  context: CliContext = defaultContext(),
): Promise<number> {
  return dispatch(parseArgs(argv), context);
}

async function dispatch(parsed: ParsedArgs, context: CliContext): Promise<number> {
  const out = (text: string) => context.stdout.write(`${text}\n`);
  const err = (text: string) => context.stderr.write(`${text}\n`);

  switch (parsed.kind) {
    case "help":
      out(HELP_TEXT.trimEnd());
      return 0;

    case "version":
      out(context.version);
      return 0;

    // Deliberately silent: in proxy mode stdout carries the child's protocol
    // traffic and nothing else.
    case "proxy":
      return runProxy(parsed.command, parsed.args, {
        stdin: context.stdin,
        stdout: context.stdout,
        stderr: context.stderr,
      });

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
