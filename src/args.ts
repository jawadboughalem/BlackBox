/**
 * Argument parsing for the `mcp-blackbox` CLI.
 *
 * The parser is a pure function of `argv` so it can be unit tested without
 * touching the process, the filesystem or the current working directory.
 */

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  /** `mcp-blackbox -- <command> [args...]` */
  | { kind: "proxy"; command: string; args: string[] }
  /** `mcp-blackbox verify [path] [--json]` */
  | { kind: "verify"; path: string | null; json: boolean }
  /** `mcp-blackbox summary [path] [--json]` */
  | { kind: "summary"; path: string | null; json: boolean }
  | { kind: "error"; message: string };

const HELP_FLAGS = new Set(["-h", "--help", "help"]);
const VERSION_FLAGS = new Set(["-V", "-v", "--version", "version"]);

/**
 * Parses the CLI arguments (i.e. `process.argv.slice(2)`).
 *
 * Never throws: unusable input is reported as an `error` result so the caller
 * decides how to render it and which exit code to use.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [first, ...rest] = argv;

  if (first === undefined) return { kind: "help" };

  // Proxy mode: everything after the separator is the server command, verbatim.
  // The separator has to come first — `mcp-blackbox -- npx some-server --flag`.
  if (first === "--") {
    const [command, ...args] = rest;
    if (command === undefined) {
      return {
        kind: "error",
        message: "`--` must be followed by the MCP server command to run.",
      };
    }
    return { kind: "proxy", command, args };
  }

  if (HELP_FLAGS.has(first)) return { kind: "help" };
  if (VERSION_FLAGS.has(first)) return { kind: "version" };

  if (first === "verify" || first === "summary") {
    return parseSubcommandWithPath(first, rest);
  }

  if (first.startsWith("-")) {
    return { kind: "error", message: `Unknown option: ${first}` };
  }

  return { kind: "error", message: `Unknown command: ${first}` };
}

/**
 * Parses `verify` / `summary`: an optional path and an optional `--json`, in
 * either order. The path stays null when omitted so the command can fall back
 * to the default journal rather than guessing here.
 */
function parseSubcommandWithPath(
  kind: "verify" | "summary",
  rest: readonly string[],
): ParsedArgs {
  let path: string | null = null;
  let json = false;

  for (const argument of rest) {
    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--") {
      return {
        kind: "error",
        message: "`--` is only valid as the first argument, before a server command.",
      };
    }

    if (argument.startsWith("-")) {
      return { kind: "error", message: `Unknown option for \`${kind}\`: ${argument}` };
    }

    if (path !== null) {
      return {
        kind: "error",
        message: `\`${kind}\` accepts at most one path, got "${path}" and "${argument}"`,
      };
    }

    path = argument;
  }

  return { kind, path, json };
}
