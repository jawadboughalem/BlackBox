import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, hashValue, sha256 } from "../src/canonical-json.js";
import { computeEntryHash, type JournalEntry } from "../src/journal.js";
import { REDACTED } from "../src/redact.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

interface Run {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  dir: string;
}

/** Runs the proxy with the journal pointed at a throwaway directory. */
function proxied(
  input: string | Buffer,
  options: { dir?: string; serverArgs?: string[]; cwd?: string } = {},
): Promise<Run> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "blackbox-record-"));
  const child = spawn(
    process.execPath,
    [CLI, "--", process.execPath, SERVER, ...(options.serverArgs ?? [])],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_BLACKBOX_DIR: dir },
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
  );

  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);

  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ stdout: Buffer.concat(stdout), stderr, code, dir }));
  });
}

/** Each session writes its own file, so collect whatever is in the directory. */
function journalFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => /^journal(-[^/\\]*)?\.jsonl$/.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function entriesIn(path: string): JournalEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalEntry);
}

function readJournal(dir: string): JournalEntry[] {
  return journalFiles(dir).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as JournalEntry),
  );
}

function verifyChain(entries: JournalEntry[]): boolean {
  let previous = GENESIS_HASH;
  for (const [index, item] of entries.entries()) {
    if (item.seq !== index + 1) return false;
    if (item.prev_hash !== previous) return false;
    const { hash, ...rest } = item;
    if (computeEntryHash(rest) !== hash) return false;
    previous = hash;
  }
  return true;
}

const line = (message: unknown) => `${JSON.stringify(message)}\n`;

const INITIALIZE = line({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

const call = (id: number, name: string, args: unknown = {}) =>
  line({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe.skipIf(!existsSync(CLI))("recording", () => {
  it("records one entry per completed tools/call", async () => {
    const { dir } = await proxied(INITIALIZE + call(2, "echo", { text: "hi" }));
    const entries = readJournal(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      seq: 1,
      tool: "echo",
      outcome: "ok",
      error_message: null,
      prev_hash: GENESIS_HASH,
      args_redacted: { text: "hi" },
    });
  });

  it("records nothing for a session with no tools/call", async () => {
    const { dir } = await proxied(INITIALIZE);
    expect(readJournal(dir)).toHaveLength(0);
  });

  it("names the server from its initialize response", async () => {
    const { dir } = await proxied(INITIALIZE + call(2, "echo"));
    expect(readJournal(dir)[0]!.server).toBe("fake-mcp-server");
  });

  it("stamps an ISO 8601 timestamp and a duration", async () => {
    const { dir } = await proxied(INITIALIZE + call(2, "echo"));
    const [entry] = readJournal(dir);
    expect(entry!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(entry!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("redacts credential-looking arguments but still hashes the originals", async () => {
    const a = await proxied(INITIALIZE + call(2, "login", { user: "jo", api_key: "secret-value" }));
    const b = await proxied(INITIALIZE + call(2, "login", { user: "jo", api_key: "different" }));

    const first = readJournal(a.dir)[0]!;
    expect(first.args_redacted).toEqual({ user: "jo", api_key: REDACTED });
    expect(JSON.stringify(first.args_redacted)).not.toContain("secret-value");
    // The hash covers the real arguments, so different secrets stay distinguishable.
    expect(first.args_hash).not.toBe(readJournal(b.dir)[0]!.args_hash);
  });

  // The whole redaction layer rests on this: what is written is scrubbed, what
  // is hashed is not, so the hash still identifies the real call.
  it("hashes the original arguments, not the redacted copy", async () => {
    const args = { user: "jo", password: "hunter2", note: "ping jo@example.com" };
    const { dir } = await proxied(INITIALIZE + call(2, "login", args));
    const [entry] = readJournal(dir);

    expect(entry!.args_redacted).toEqual({
      user: "jo",
      password: REDACTED,
      note: "ping [redacted:email]",
    });
    expect(entry!.args_hash).toBe(hashValue(args));
    expect(entry!.args_hash).not.toBe(hashValue(entry!.args_redacted));
  });

  it("applies all three redaction mechanisms end to end", async () => {
    const args = {
      api_key: "sk-abcdefghijklmnopqrstuvwxyz0123",
      contact: "jo@example.com",
      card: "4242 4242 4242 4242",
      body: "z".repeat(600),
    };
    const { dir } = await proxied(INITIALIZE + call(2, "submit", args));
    const redacted = readJournal(dir)[0]!.args_redacted as Record<string, unknown>;

    expect(redacted["api_key"]).toBe(REDACTED);
    expect(redacted["contact"]).toBe("[redacted:email]");
    expect(redacted["card"]).toBe("[redacted:card]");
    expect(redacted["body"]).toBe(`<truncated:${sha256("z".repeat(600))}>`);

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain("sk-abcdefghij");
    expect(serialised).not.toContain("jo@example.com");
    expect(serialised).not.toContain("4242");
    expect(serialised).not.toContain("zzzz");
  });

  it("honours .mcp-blackbox.json from the working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "blackbox-cfg-"));
    writeFileSync(
      join(cwd, ".mcp-blackbox.json"),
      JSON.stringify({ redaction: { keys: ["project_ref"], disablePatterns: ["email"] } }),
    );

    const { dir } = await proxied(
      INITIALIZE + call(2, "submit", { project_ref: "P-1", contact: "jo@example.com" }),
      { cwd },
    );

    expect(readJournal(dir)[0]!.args_redacted).toEqual({
      project_ref: REDACTED,
      contact: "jo@example.com",
    });
  });

  it("builds a valid chain over 100 calls", async () => {
    let input = INITIALIZE;
    for (let index = 0; index < 100; index += 1) {
      input += call(index + 2, `tool-${index}`, { index });
    }

    const { dir, stdout } = await proxied(input);
    const entries = readJournal(dir);

    expect(entries).toHaveLength(100);
    expect(verifyChain(entries)).toBe(true);
    expect(entries.map((item) => item.seq)).toEqual(
      Array.from({ length: 100 }, (_unused, index) => index + 1),
    );
    expect(entries[99]!.tool).toBe("tool-99");
    // The relay is unaffected: every response still came back.
    expect(stdout.toString().split("\n").filter(Boolean)).toHaveLength(101);
  }, 30_000);

  // Sessions do not share a file. Two proxies appending to one journal would
  // each read the tail at startup, claim the same sequence numbers and
  // interleave their writes, breaking a chain nobody tampered with.
  it("gives each session its own file, each with its own chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blackbox-record-"));
    await proxied(INITIALIZE + call(2, "first"), { dir });
    await proxied(INITIALIZE + call(2, "second"), { dir });

    const files = journalFiles(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const entries = entriesIn(file);
      expect(entries).toHaveLength(1);
      expect(verifyChain(entries)).toBe(true);
    }
    expect(readJournal(dir).map((item) => item.tool)).toEqual(["first", "second"]);
  });

  it("keeps chains valid when two proxies record at the same time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blackbox-record-"));
    let input = INITIALIZE;
    for (let index = 0; index < 8; index += 1) input += call(index + 2, `tool-${index}`);

    await Promise.all([proxied(input, { dir }), proxied(input, { dir })]);

    const files = journalFiles(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const entries = entriesIn(file);
      expect(entries.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(verifyChain(entries)).toBe(true);
    }
  }, 30_000);

  describe("records failures", () => {
    it("marks a JSON-RPC error as an error and keeps its message", async () => {
      const { dir } = await proxied(INITIALIZE + call(2, "explode"));
      const [entry] = readJournal(dir);
      expect(entry).toMatchObject({
        tool: "explode",
        outcome: "error",
        error_message: "Unknown tool: explode",
      });
    });

    // MCP has a second failure mode: the call succeeds at the protocol level
    // and the result carries isError. That is still a failed call.
    it("marks a tool-level isError result as an error", async () => {
      const { dir } = await proxied(INITIALIZE + call(2, "tool-error"));
      const [entry] = readJournal(dir);
      expect(entry).toMatchObject({
        tool: "tool-error",
        outcome: "error",
        error_message: "disk on fire",
      });
    });

    it("keeps the chain valid across mixed outcomes", async () => {
      const { dir } = await proxied(
        INITIALIZE + call(2, "echo") + call(3, "explode") + call(4, "tool-error") + call(5, "echo"),
      );
      const entries = readJournal(dir);
      expect(entries.map((item) => item.outcome)).toEqual(["ok", "error", "error", "ok"]);
      expect(verifyChain(entries)).toBe(true);
    });

    it("hashes the error payload as the result", async () => {
      const a = await proxied(INITIALIZE + call(2, "echo"));
      const b = await proxied(INITIALIZE + call(2, "explode"));
      expect(readJournal(b.dir)[0]!.result_hash).not.toBe(readJournal(a.dir)[0]!.result_hash);
    });
  });

  describe("resilience", () => {
    it("relays normally and records nothing when the journal is unwritable", async () => {
      const base = mkdtempSync(join(tmpdir(), "blackbox-record-"));
      const file = join(base, "not-a-directory");
      writeFileSync(file, "blocked");
      const dir = join(file, "nested");

      const { stdout, stderr, code } = await proxied(INITIALIZE + call(2, "echo"), { dir });

      const responses = stdout.toString().split("\n").filter(Boolean);
      expect(responses).toHaveLength(2);
      expect(JSON.parse(responses[1]!)).toMatchObject({ id: 2, result: {} });
      expect(code).toBe(0);
      expect(journalFiles(dir)).toEqual([]);
      // Losing coverage is reported, never silent — but only on stderr, so the
      // relay on stdout is untouched.
      expect(stderr).toContain("recording disabled");
    });

    it("relays normally when the journal directory is read-only", async () => {
      const readOnly = process.platform !== "win32" && process.getuid?.() !== 0;
      const dir = mkdtempSync(join(tmpdir(), "blackbox-record-"));
      mkdirSync(dir, { recursive: true });
      if (readOnly) chmodSync(dir, 0o555);

      try {
        const { stdout, code, stderr } = await proxied(INITIALIZE + call(2, "echo"), { dir });
        expect(stdout.toString().split("\n").filter(Boolean)).toHaveLength(2);
        expect(code).toBe(0);
        if (readOnly) expect(stderr).toContain("recording disabled");
      } finally {
        if (readOnly) chmodSync(dir, 0o755);
      }
    });

    it("survives malformed JSON in the stream", async () => {
      const input =
        INITIALIZE +
        "this is not json at all\n" +
        "{unclosed\n" +
        "\n" +
        call(2, "echo") +
        "[1,2,3]\n";

      const { dir, stdout, code } = await proxied(input);

      // The tools/call around the noise is still recorded, and the chain holds.
      const entries = readJournal(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.tool).toBe("echo");
      expect(verifyChain(entries)).toBe(true);
      expect(code).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
    });

    it("keeps the relay byte-identical while recording", async () => {
      const input = INITIALIZE + call(2, "echo", { text: "hi" });
      const withJournal = await proxied(input);

      const bare = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      bare.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      bare.stdin.end(input);
      await new Promise((resolve) => bare.on("close", resolve));

      expect(withJournal.stdout.equals(Buffer.concat(chunks))).toBe(true);
      expect(readJournal(withJournal.dir)).toHaveLength(1);
    });

    it("does not record a call that never gets a response", async () => {
      // stdin closes right after the request; the fixture replies, so use an id
      // the fixture never answers: a notification has no id at all.
      const { dir } = await proxied(
        INITIALIZE + line({ jsonrpc: "2.0", method: "tools/call", params: { name: "ghost" } }),
      );
      expect(readJournal(dir)).toHaveLength(0);
    });
  });
});
