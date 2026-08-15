import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalJson, sha256 } from "../src/canonical-json.js";
import {
  Journal,
  computeEntryHash,
  journalDir,
  sessionJournalName,
  type EntryInput,
  type JournalEntry,
} from "../src/journal.js";

const opened: Journal[] = [];

/** Opens a fixed file, so append and resume behaviour stays observable. */
function openIn(dir: string): Journal {
  const journal = Journal.openAt(join(dir, "journal.jsonl"));
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

describe("journalDir", () => {
  it("defaults to ~/.mcp-blackbox", () => {
    expect(journalDir({ env: {} as NodeJS.ProcessEnv, home: "/home/someone" })).toBe(
      join("/home/someone", ".mcp-blackbox"),
    );
  });

  it("honours MCP_BLACKBOX_DIR", () => {
    expect(
      journalDir({
        env: { MCP_BLACKBOX_DIR: "/tmp/elsewhere" } as NodeJS.ProcessEnv,
        home: "/home/someone",
      }),
    ).toBe("/tmp/elsewhere");
  });

  it("ignores an empty override", () => {
    expect(
      journalDir({ env: { MCP_BLACKBOX_DIR: "   " } as NodeJS.ProcessEnv, home: "/home/someone" }),
    ).toBe(join("/home/someone", ".mcp-blackbox"));
  });
});

describe("sessionJournalName", () => {
  // Sessions must never share a file: two proxies appending to one journal
  // would each claim the same sequence numbers and break the chain.
  it("is unique per process", () => {
    const now = new Date("2026-08-15T17:10:00.000Z");
    expect(sessionJournalName(now, 111)).not.toBe(sessionJournalName(now, 222));
  });

  it("is unique per start time", () => {
    expect(sessionJournalName(new Date("2026-08-15T17:10:00.000Z"), 1)).not.toBe(
      sessionJournalName(new Date("2026-08-15T17:10:01.000Z"), 1),
    );
  });

  it("sorts chronologically by name", () => {
    const earlier = sessionJournalName(new Date("2026-08-15T17:10:00.000Z"), 9);
    const later = sessionJournalName(new Date("2026-08-15T18:00:00.000Z"), 1);
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it("looks like a journal file", () => {
    expect(sessionJournalName(new Date("2026-08-15T17:10:00.000Z"), 42)).toBe(
      "journal-20260815T171000Z-42.jsonl",
    );
  });
});

describe("Journal.open", () => {
  it("writes to a file of its own, never a shared one", () => {
    const dir = tempDir();
    const first = Journal.open({ env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv });
    opened.push(first);
    expect(first.enabled).toBe(true);
    expect(first.path).not.toBe(join(dir, "journal.jsonl"));
    expect(first.path.startsWith(join(dir, "journal-"))).toBe(true);
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

  // The journal holds tool arguments and file paths; on a shared machine the
  // default 0644 would let every other user read them.
  it.skipIf(process.platform === "win32")("creates a private file and directory", () => {
    const dir = tempDir();
    const journal = openIn(dir);
    journal.record(entry());

    expect(statSync(join(dir, "journal.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("tightens a journal left readable by an older run", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "journal.jsonl");
    writeFileSync(path, "");
    chmodSync(path, 0o644);

    openIn(dir).record(entry());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves no file behind when a session records nothing", () => {
    const dir = tempDir();
    const journal = Journal.open({ env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv });
    const path = journal.path;
    expect(existsSync(path)).toBe(true);
    journal.close();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a file that holds entries", () => {
    const dir = tempDir();
    const journal = Journal.open({ env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv });
    journal.record(entry());
    journal.close();
    expect(existsSync(journal.path)).toBe(true);
  });

  it("never removes a file it did not create", () => {
    const dir = tempDir();
    const first = openIn(dir);
    first.record(entry());
    first.close();

    const second = openIn(dir);
    second.close();
    expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
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
