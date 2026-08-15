import { parseArgs, type ParsedArgs } from "./args.js";
import { loadConfig } from "./config.js";
import { HELP_TEXT } from "./help.js";
import { Journal } from "./journal.js";
import { readJournalLines, resolveJournalTargets, type JournalLine } from "./journal-reader.js";
import { runProxy } from "./proxy.js";
import { CallRecorder } from "./recorder.js";
import { formatSummary, summarise } from "./summary.js";
import { formatVerify, verifyJournals } from "./verify.js";
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

/** Exit code for a broken chain, or a journal that could not be read. */
export const EXIT_FAILED = 1;

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
 * Proxy mode relays and records; `verify` and `summary` read the journals back.
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
    case "proxy": {
      // A journal that cannot be opened is a disabled journal, never an error:
      // recording must not be able to stop the user's server from running.
      const journal = Journal.open();
      const invocation = [parsed.command, ...parsed.args].join(" ");
      const config = loadConfig();
      // A config problem means less redaction than the user asked for, so it
      // is reported rather than swallowed. stderr only: stdout is the relay.
      for (const problem of config.problems) {
        err(`mcp-blackbox: ${problem}`);
      }
      const recorder = new CallRecorder(journal, invocation, {
        redaction: config.redaction,
      });
      try {
        return await runProxy(
          parsed.command,
          parsed.args,
          { stdin: context.stdin, stdout: context.stdout, stderr: context.stderr },
          recorder,
        );
      } finally {
        journal.close();
      }
    }

    case "verify": {
      let journals;
      try {
        journals = readTargets(parsed.path);
      } catch (error) {
        err(`error: ${describe(error)}`);
        return EXIT_FAILED;
      }

      const result = verifyJournals(journals);
      out(parsed.json ? JSON.stringify(result, null, 2) : formatVerify(result));
      return result.ok ? 0 : EXIT_FAILED;
    }

    case "summary": {
      let journals;
      try {
        journals = readTargets(parsed.path);
      } catch (error) {
        err(`error: ${describe(error)}`);
        return EXIT_FAILED;
      }

      const result = summarise(
        journals.flatMap((journal) => journal.lines),
        journals.map((journal) => journal.path),
      );
      out(parsed.json ? JSON.stringify(result, null, 2) : formatSummary(result));
      return 0;
    }

    case "error":
      err(`error: ${parsed.message}`);
      err("");
      err(HELP_TEXT.trimEnd());
      return EXIT_USAGE;
  }
}

/** Loads every journal the path argument resolves to. */
function readTargets(path: string | null): Array<{ path: string; lines: JournalLine[] }> {
  return resolveJournalTargets(path).map((target) => ({
    path: target,
    lines: readJournalLines(target),
  }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
