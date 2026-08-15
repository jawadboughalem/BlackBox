import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalJson, sha256 } from "../src/canonical-json.js";
import { Journal, computeEntryHash, journalPath, type EntryInput, type JournalEntry } from "../src/journal.js";

const opened: Journal[] = [];

function openIn(dir: string): Journal {
  const journal = Journal.open({ env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv });
  opened.push(journal);
  return journal;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "blackbox-journal-"));
}

function entry(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    server: "fake-server",
    tool: "echo",
    args_redacted: { text: "hi" },
    args_hash: sha256("args"),
    outcome: "ok",
    error_message: null,
    duration_ms: 5,
    result_hash: sha256("result"),
    ...overrides,
  };
}

function readEntries(dir: string): JournalEntry[] {
  const contents = readFileSync(join(dir, "journal.jsonl"), "utf8");
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalEntry);
}

/** Re-derives the chain the way an auditor would, from the file alone. */
function verifyChain(entries: JournalEntry[]): { ok: boolean; reason?: string } {
  let previous = GENESIS_HASH;
  for (const [index, item] of entries.entries()) {
    if (item.seq !== index + 1) return { ok: false, reason: `seq ${item.seq} at index ${index}` };
    if (item.prev_hash !== previous) return { ok: false, reason: `prev_hash at seq ${item.seq}` };
    const { hash, ...rest } = item;
    if (computeEntryHash(rest) !== hash) return { ok: false, reason: `hash at seq ${item.seq}` };
    previous = hash;
  }
  return { ok: true };
}

afterEach(() => {
  for (const journal of opened.splice(0)) journal.close();
});

describe("journalPath", () => {
  it("defaults to ~/.mcp-blackbox/journal.jsonl", () => {
    const path = journalPath({ env: {} as NodeJS.ProcessEnv, home: "/home/someone" });
    expect(path).toBe(join("/home/someone", ".mcp-blackbox", "journal.jsonl"));
  });

  it("honours MCP_BLACKBOX_DIR", () => {
    const path = journalPath({
      env: { MCP_BLACKBOX_DIR: "/tmp/elsewhere" } as NodeJS.ProcessEnv,
      home: "/home/someone",
    });
    expect(path).toBe(join("/tmp/elsewhere", "journal.jsonl"));
  });

  it("ignores an empty override", () => {
    const path = journalPath({
      env: { MCP_BLACKBOX_DIR: "   " } as NodeJS.ProcessEnv,
      home: "/home/someone",
    });
    expect(path).toBe(join("/home/someone", ".mcp-blackbox", "journal.jsonl"));
  });
});

describe("Journal", () => {
  it("writes the schema fields in order", () => {
    const dir = tempDir();
    openIn(dir).record(entry());
    const [written] = readEntries(dir);
    expect(Object.keys(written!)).toEqual([
      "seq",
      "ts",
      "server",
      "tool",
      "args_redacted",
      "args_hash",
      "outcome",
      "error_message",
      "duration_ms",
      "result_hash",
      "prev_hash",
      "hash",
    ]);
  });

  it("starts the chain at the genesis hash", () => {
    const dir = tempDir();
    openIn(dir).record(entry());
    const [first] = readEntries(dir);
    expect(first!.seq).toBe(1);
    expect(first!.prev_hash).toBe(GENESIS_HASH);
  });

  it("hashes the entry without its own hash field", () => {
    const dir = tempDir();
    openIn(dir).record(entry());
    const [written] = readEntries(dir);
    const { hash, ...rest } = written!;
    expect(hash).toBe(sha256(canonicalJson(rest)));
  });

  it("builds a valid chain over 100 entries", () => {
    const dir = tempDir();
    const journal = openIn(dir);
    for (let index = 0; index < 100; index += 1) {
      journal.record(entry({ tool: `tool-${index}`, duration_ms: index }));
    }

    const entries = readEntries(dir);
    expect(entries).toHaveLength(100);
    expect(verifyChain(entries)).toEqual({ ok: true });
    expect(entries.at(-1)!.seq).toBe(100);
  });

  it("detects a tampered entry", () => {
    const dir = tempDir();
    const journal = openIn(dir);
    for (let index = 0; index < 5; index += 1) journal.record(entry());

    const entries = readEntries(dir);
    entries[2]!.tool = "something-else";
    expect(verifyChain(entries).ok).toBe(false);
  });

  it("continues the chain when reopened", () => {
    const dir = tempDir();
    const first = openIn(dir);
    first.record(entry());
    first.record(entry());
    first.close();

    const second = openIn(dir);
    expect(second.nextSeq).toBe(3);
    second.record(entry());

    const entries = readEntries(dir);
    expect(entries).toHaveLength(3);
    expect(verifyChain(entries)).toEqual({ ok: true });
  });

  it("refuses to append onto a corrupt tail rather than break the chain", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), "{not json at all\n");

    const journal = openIn(dir);
    expect(journal.enabled).toBe(false);
    expect(journal.record(entry())).toBeNull();
  });

  it("ignores a trailing blank line when resuming", () => {
    const dir = tempDir();
    const first = openIn(dir);
    first.record(entry());
    first.close();
    writeFileSync(join(dir, "journal.jsonl"), `${readFileSync(join(dir, "journal.jsonl"), "utf8")}\n`);

    const second = openIn(dir);
    expect(second.enabled).toBe(true);
    expect(second.nextSeq).toBe(2);
  });

  describe("when the journal cannot be written", () => {
    /** A path whose parent is a regular file: unwritable on every platform. */
    function blockedDir(): string {
      const base = tempDir();
      const file = join(base, "not-a-directory");
      writeFileSync(file, "blocked");
      return join(file, "nested");
    }

    it("opens in a disabled state instead of throwing", () => {
      const journal = openIn(blockedDir());
      expect(journal.enabled).toBe(false);
    });

    it("returns null from record instead of throwing", () => {
      const journal = openIn(blockedDir());
      expect(() => journal.record(entry())).not.toThrow();
      expect(journal.record(entry())).toBeNull();
    });

    it("creates no file", () => {
      const dir = blockedDir();
      openIn(dir).record(entry());
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(false);
    });
  });

  // Root ignores the read-only bit, and Windows does not honour chmod at all.
  const canTestReadOnly = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!canTestReadOnly)("stays disabled on a read-only directory", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(dir, 0o555);
    try {
      const journal = openIn(dir);
      expect(journal.enabled).toBe(false);
      expect(journal.record(entry())).toBeNull();
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("keeps working after being closed", () => {
    const dir = tempDir();
    const journal = openIn(dir);
    journal.record(entry());
    journal.close();
    expect(journal.enabled).toBe(false);
    expect(journal.record(entry())).toBeNull();
    expect(readEntries(dir)).toHaveLength(1);
  });
});
