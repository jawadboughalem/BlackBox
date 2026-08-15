import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { LineTap } from "./line-tap.js";
import type { CallRecorder } from "./recorder.js";

/** Raw streams the relay moves bytes between. */
export interface ProxyStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Signals forwarded to the child instead of killing the proxy outright. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** How long the child gets to honour a forwarded signal before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** Conventional shell exit code for a command that could not be run. */
const EXIT_COMMAND_NOT_FOUND = 127;

/**
 * Runs `command` as a child process and relays stdio between it and the parent.
 *
 * The relay is byte-transparent: stdout is framed into `\n`-terminated lines so
 * later phases can inspect them, but each line is written back exactly as it
 * arrived — malformed JSON, blank lines and partial trailing output included.
 * Nothing else is ever written to stdout.
 *
 * Resolves with the exit code to propagate: the child's own code, or
 * `128 + signal` when it was killed by one.
 */
export function runProxy(
  command: string,
  args: readonly string[],
  streams: ProxyStreams,
  recorder?: CallRecorder,
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnChild(command, args);
    } catch (error) {
      streams.stderr.write(`mcp-blackbox: ${describe(error)}\n`);
      resolve(EXIT_COMMAND_NOT_FOUND);
      return;
    }

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let inboundTap: LineTap | undefined;

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      for (const signal of FORWARDED_SIGNALS) {
        process.off(signal, onSignal);
      }
      // Stop pulling on the parent's stdin, otherwise the read handle keeps the
      // event loop alive long after the child is gone.
      if (inboundTap) streams.stdin.unpipe(inboundTap);
      streams.stdin.pause();
    };

    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };

    const onSignal = (signal: (typeof FORWARDED_SIGNALS)[number]) => {
      if (settled) return;
      child.kill(signal);
      // A child that ignores the signal must not strand the proxy.
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    for (const signal of FORWARDED_SIGNALS) {
      process.on(signal, onSignal);
    }

    // Parent stdin -> child stdin. The child may exit while we still hold
    // buffered input; that surfaces as EPIPE and is not an error here.
    if (child.stdin) {
      child.stdin.on("error", () => {});
      inboundTap = new LineTap((line) => recorder?.observeRequest(line));
      streams.stdin.pipe(inboundTap).pipe(child.stdin);
    }

    if (child.stdout) {
      const outboundTap = new LineTap((line) => recorder?.observeResponse(line));
      // end: false — the child closing its stdout must not close the proxy's.
      child.stdout.pipe(outboundTap).pipe(streams.stdout, { end: false });
    }

    if (child.stderr) child.stderr.on("data", (chunk: Buffer) => streams.stderr.write(chunk));

    child.on("error", (error) => {
      streams.stderr.write(`mcp-blackbox: ${describe(error)}\n`);
      settle(EXIT_COMMAND_NOT_FOUND);
    });

    child.on("close", (code, signal) => {
      if (signal) settle(128 + signalNumber(signal));
      else settle(code ?? 0);
    });
  });
}

function spawnChild(command: string, args: readonly string[]): ChildProcess {
  const useShell = needsShell(command);
  return spawn(
    useShell ? quoteForCmd(command) : command,
    useShell ? args.map(quoteForCmd) : [...args],
    { stdio: ["pipe", "pipe", "pipe"], shell: useShell },
  );
}

/**
 * Windows cannot spawn `npx`, `npm` and friends directly: they are `.cmd`
 * shims, which Node refuses to execute without a shell. Real executables are
 * spawned directly everywhere so argument handling stays predictable.
 */
export function needsShell(command: string, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  return !/\.(exe|com)$/i.test(command);
}

/**
 * Quotes an argument for `cmd.exe`, which Node does not do when `shell` is set.
 * Without this, any path containing a space arrives at the child split in two.
 */
export function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&()<>^|]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
