import { hashValue } from "./canonical-json.js";
import type { Journal } from "./journal.js";
import { defaultConfig, redact, type RedactionConfig } from "./redact.js";

/** Cap on in-flight calls, so a server that never answers cannot grow memory. */
const MAX_PENDING = 1_000;

/** Longest tool error message kept in the journal. */
const MAX_ERROR_MESSAGE = 1_000;

interface PendingCall {
  tool: string;
  args: unknown;
  startedAt: number;
}

type JsonRpcId = string | number;

/**
 * Watches relayed JSON-RPC traffic and records each completed `tools/call`.
 *
 * Requests are matched to responses by id. Anything that is not a tools/call —
 * notifications, other methods, unparseable lines — is ignored. Observation is
 * strictly passive: no method here throws, because the relay must not depend on
 * the recorder understanding what went past.
 */
export interface RecorderOptions {
  /** Redaction rules applied to arguments before they are written. */
  redaction?: RedactionConfig;
  /** Injectable clock, so duration is testable. */
  now?: () => number;
  /**
   * Called when a call could not be recorded. A journal that quietly loses
   * entries is worse than one that says so: `verify` cannot detect a call that
   * was never written, so the only chance to report it is here.
   */
  onProblem?: (message: string) => void;
}

export class CallRecorder {
  readonly #journal: Journal;
  readonly #fallbackServer: string;
  readonly #pending = new Map<string, PendingCall>();
  readonly #redaction: RedactionConfig;
  readonly #onProblem: (message: string) => void;
  #initializeId: string | null = null;
  #serverName: string | null = null;
  #now: () => number;

  constructor(journal: Journal, fallbackServer: string, options: RecorderOptions = {}) {
    this.#journal = journal;
    this.#fallbackServer = fallbackServer;
    this.#redaction = options.redaction ?? defaultConfig();
    this.#now = options.now ?? (() => performance.now());
    this.#onProblem = options.onProblem ?? (() => {});
  }

  /** Number of calls awaiting a response; exposed for tests. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  observeRequest(line: Buffer): void {
    const message = parse(line);
    if (message === null) return;

    const id = readId(message["id"]);
    if (id === null) return; // a notification: nothing will come back

    if (message["method"] === "initialize") {
      this.#initializeId = id;
      return;
    }

    if (message["method"] !== "tools/call") return;

    const params = asRecord(message["params"]);
    const tool = typeof params?.["name"] === "string" ? params["name"] : "";

    if (this.#pending.size >= MAX_PENDING) {
      // Drop the oldest rather than the newest: a stale call is the one least
      // likely to ever be answered.
      const oldest = this.#pending.keys().next();
      if (!oldest.done) this.#pending.delete(oldest.value);
    }

    this.#pending.set(id, { tool, args: params?.["arguments"], startedAt: this.#now() });
  }

  observeResponse(line: Buffer): void {
    const message = parse(line);
    if (message === null) return;

    const id = readId(message["id"]);
    if (id === null) return;

    // The server names itself in its initialize result; that beats echoing back
    // whatever command line happened to launch it.
    if (id === this.#initializeId) {
      const info = asRecord(asRecord(message["result"])?.["serverInfo"]);
      if (typeof info?.["name"] === "string") this.#serverName = info["name"];
      this.#initializeId = null;
      return;
    }

    const call = this.#pending.get(id);
    if (call === undefined) return;
    this.#pending.delete(id);

    const { outcome, errorMessage, payload } = interpret(message);

    try {
      this.#journal.record({
        ts: new Date().toISOString(),
        server: this.#serverName ?? this.#fallbackServer,
        tool: call.tool,
        args_redacted: redact(call.args, this.#redaction),
        // Deliberately the original arguments, not the redacted copy: the hash
        // has to identify what was really sent.
        args_hash: hashValue(call.args ?? null),
        outcome,
        error_message: errorMessage,
        duration_ms: Math.round(this.#now() - call.startedAt),
        result_hash: hashValue(payload ?? null),
      });
    } catch (error) {
      // The relay carries on regardless; this only makes the gap visible.
      const reason = error instanceof Error ? error.message : String(error);
      this.#onProblem(`could not record a call to "${call.tool}": ${reason}`);
    }
  }
}

/**
 * Decides whether a response counts as a failure. MCP has two distinct ways to
 * fail: a JSON-RPC `error`, and a successful response carrying `isError` for a
 * tool that ran and reported failure. Both are recorded as `error`.
 */
function interpret(message: Record<string, unknown>): {
  outcome: "ok" | "error";
  errorMessage: string | null;
  payload: unknown;
} {
  const error = asRecord(message["error"]);
  if (error !== null) {
    const text = typeof error["message"] === "string" ? error["message"] : "unknown error";
    return { outcome: "error", errorMessage: clamp(text), payload: message["error"] };
  }

  const result = asRecord(message["result"]);
  if (result?.["isError"] === true) {
    return { outcome: "error", errorMessage: clamp(textOf(result)), payload: message["result"] };
  }

  return { outcome: "ok", errorMessage: null, payload: message["result"] };
}

/** Pulls the first text block out of an MCP tool result. */
function textOf(result: Record<string, unknown>): string {
  const content = result["content"];
  if (!Array.isArray(content)) return "tool reported an error";
  for (const block of content) {
    const item = asRecord(block);
    if (item?.["type"] === "text" && typeof item["text"] === "string") return item["text"];
  }
  return "tool reported an error";
}

function clamp(text: string): string {
  return text.length <= MAX_ERROR_MESSAGE ? text : `${text.slice(0, MAX_ERROR_MESSAGE)}…`;
}

/** Parses a relayed line, returning null for anything that is not an object. */
function parse(line: Buffer): Record<string, unknown> | null {
  const text = line.toString("utf8").trim();
  if (text === "") return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null; // not JSON: the relay still forwarded it untouched
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Normalises a JSON-RPC id, keeping string and number ids distinct. */
function readId(value: unknown): string | null {
  if (typeof value === "number") return `n:${value}`;
  if (typeof value === "string") return `s:${value}`;
  return null;
}

export type { JsonRpcId };
