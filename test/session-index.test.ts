import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH } from "../src/canonical-json.js";
import { Journal } from "../src/journal.js";
import { readJournalLines } from "../src/journal-reader.js";
import { computeIndexHash, indexPath, readIndexEntries, type IndexEntry } from "../src/session-index.js";
import { verifyIndex, type JournalFacts } from "../src/verify-index.js";
import { formatVerify, verifyJournals, withIndex } from "../src/verify.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "blackbox-index-"));
}

/** Records a session the way the proxy does: open, write, close. */
function session(dir: string, tool: string, count = 3): string {
  const journal = Journal.open({ env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv });
  for (let index = 0; index < count; index += 1) {
    journal.record({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      server: "srv",
      tool,
      args_redacted: {},
      args_hash: `sha256:${"a".repeat(64)}`,
      outcome: "ok",
      error_kind: null,
      error_message: null,
      duration_ms: index,
      result_hash: `sha256:${"b".repeat(64)}`,
    });
  }
  journal.close();
  return journal.path;
}

/** Two sessions cannot share a filename, so give the second its own second. */
function twoSessions(dir: string): { first: string; second: string } {
  const first = session(dir, "innocent");
  const second = openLater(dir, "the-mistake");
  return { first, second };
}

/** Same as `session`, but with a name that cannot collide with the previous. */
function openLater(dir: string, tool: string): string {
  const path = join(dir, `journal-20990101T000000Z-${Math.floor(process.hrtime()[1] % 100000)}.jsonl`);
  const journal = Journal.openAt(path, { index: true });
  journal.record({
    ts: "2099-01-01T00:00:00.000Z",
    server: "srv",
    tool,
    args_redacted: {},
    args_hash: `sha256:${"a".repeat(64)}`,
    outcome: "ok",
    error_kind: null,
    error_message: null,
    duration_ms: 1,
    result_hash: `sha256:${"b".repeat(64)}`,
  });
  journal.close();
  return path;
}

function journalsIn(dir: string): string[] {
  return readIndexEntries(indexPath(dir))
    .map((line) => line.entry)
    .filter((entry): entry is IndexEntry => entry !== null)
    .map((entry) => join(dir, entry.file));
}

/** Runs the full check the CLI runs: journals, index, and their agreement. */
function check(dir: string, files: string[]) {
  const journals = verifyJournals(files.map((path) => ({ path, lines: readJournalLines(path) })));
  return withIndex(journals, verifyIndex(dir, files, journals.facts));
}

describe("the index", () => {
  it("records one line per session", () => {
    const dir = tempDir();
    twoSessions(dir);

    const entries = readIndexEntries(indexPath(dir)).map((line) => line.entry!);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(entries[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(entries[1]!.prev_hash).toBe(entries[0]!.hash);
  });

  it("records what the journal holds", () => {
    const dir = tempDir();
    const path = session(dir, "read", 4);
    const [entry] = readIndexEntries(indexPath(dir)).map((line) => line.entry!);

    expect(entry!.file).toBe(basename(path));
    expect(entry!.entries).toBe(4);
    expect(entry!.opened_at).toMatch(/^\d{4}-/);
    expect(entry!.closed_at).toMatch(/^\d{4}-/);

    const last = readJournalLines(path).at(-1)!.entry!;
    expect(entry!.last_entry_hash).toBe(last.hash);
  });

  it("hashes an index line without its own hash field", () => {
    const dir = tempDir();
    session(dir, "read");
    const [entry] = readIndexEntries(indexPath(dir)).map((line) => line.entry!);
    const { hash, ...rest } = entry!;
    expect(computeIndexHash(rest)).toBe(hash);
  });

  it("does not index a session that recorded nothing", () => {
    const dir = tempDir();
    Journal.open({ env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv }).close();
    expect(readIndexEntries(indexPath(dir))).toEqual([]);
  });
});

describe("verifyIndex", () => {
  it("accepts a directory where everything agrees", () => {
    const dir = tempDir();
    twoSessions(dir);
    const result = check(dir, journalsIn(dir));

    expect(result.ok).toBe(true);
    expect(result.index).toMatchObject({ sessions: 2, missing: [], unindexed: [], mismatched: [] });
    expect(formatVerify(result)).toContain("chains intact");
  });

  // The reason the index exists. Each journal is an independent chain, so a
  // deleted session leaves the survivors verifying perfectly; without the index
  // the tool would report that everything is intact.
  it("reports a session deleted whole", () => {
    const dir = tempDir();
    const { second } = twoSessions(dir);
    rmSync(second);

    const result = check(dir, journalsIn(dir).filter((path) => path !== second));
    expect(result.ok).toBe(false);
    expect(result.index!.missing).toEqual([
      { file: basename(second), seq: 2, entries: 1 },
    ]);
    expect(formatVerify(result)).toContain("MISSING");
    expect(formatVerify(result)).toContain(basename(second));
  });

  it("reports the index chain broken when a past session's line is removed too", () => {
    const dir = tempDir();
    session(dir, "innocent");
    const middle = openLater(dir, "the-mistake");
    openLater(dir, "innocent-again");
    rmSync(middle);

    const path = indexPath(dir);
    const kept = readIndexEntries(path)
      .map((line) => line.entry!)
      .filter((entry) => entry.file !== basename(middle));
    writeFileSync(path, `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const result = check(dir, journalsIn(dir));
    expect(result.ok).toBe(false);
    expect(result.index!.broken).not.toBeNull();
    expect(formatVerify(result)).toContain("BROKEN index");
  });

  // An honest limit, asserted so no one claims otherwise. Dropping entries from
  // the END of any hash chain leaves a shorter chain that still verifies; only
  // an anchor outside the file could catch it, and nothing local qualifies.
  // The index still closes the case that matters — removing a specific past
  // session — because that breaks the chain in the middle.
  it("cannot detect the most recent sessions being truncated away", () => {
    const dir = tempDir();
    session(dir, "innocent");
    const last = openLater(dir, "the-mistake");
    rmSync(last);

    const path = indexPath(dir);
    const kept = readIndexEntries(path)
      .map((line) => line.entry!)
      .filter((entry) => entry.file !== basename(last));
    writeFileSync(path, `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const result = check(dir, journalsIn(dir));
    expect(result.ok).toBe(true);
  });

  it("catches an edited index line", () => {
    const dir = tempDir();
    twoSessions(dir);
    const path = indexPath(dir);
    const entries = readIndexEntries(path).map((line) => line.entry!);
    entries[0]!.entries = 99;
    writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const result = check(dir, journalsIn(dir));
    expect(result.ok).toBe(false);
    expect(result.index!.broken!.reason).toContain("recomputed hash");
  });

  it("catches a journal whose contents no longer match the index", () => {
    const dir = tempDir();
    const first = session(dir, "read", 3);
    // Drop the last entry: the file's own chain still verifies, but it is now
    // shorter than the index recorded.
    const lines = readFileSync(first, "utf8").split("\n").filter(Boolean);
    writeFileSync(first, `${lines.slice(0, -1).join("\n")}\n`);

    const result = check(dir, [first]);
    expect(result.ok).toBe(false);
    expect(result.index!.mismatched[0]!.reason).toContain("holds 2 entries");
    expect(formatVerify(result)).toContain("MISMATCH");
  });

  it("notes a journal the index does not vouch for, without failing", () => {
    const dir = tempDir();
    session(dir, "read");
    // A session killed outright never writes its index line.
    const orphan = join(dir, "journal-20990101T000000Z-99999.jsonl");
    const journal = Journal.openAt(orphan);
    journal.record({
      ts: "2099-01-01T00:00:00.000Z",
      server: "srv",
      tool: "orphan",
      args_redacted: {},
      args_hash: `sha256:${"a".repeat(64)}`,
      outcome: "ok",
      error_kind: null,
      error_message: null,
      duration_ms: 1,
      result_hash: `sha256:${"b".repeat(64)}`,
    });
    journal.close();

    const result = check(dir, [...journalsIn(dir), orphan]);
    expect(result.ok).toBe(true);
    expect(result.index!.unindexed).toEqual([basename(orphan)]);
    expect(formatVerify(result)).toContain("not recorded in the index");
  });

  it("treats a directory with no index as entirely unvouched for", () => {
    const dir = tempDir();
    const path = join(dir, "journal.jsonl");
    const journal = Journal.openAt(path);
    journal.record({
      ts: "2026-01-01T00:00:00.000Z",
      server: "srv",
      tool: "legacy",
      args_redacted: {},
      args_hash: `sha256:${"a".repeat(64)}`,
      outcome: "ok",
      error_kind: null,
      error_message: null,
      duration_ms: 1,
      result_hash: `sha256:${"b".repeat(64)}`,
    });
    journal.close();

    const result = check(dir, [path]);
    expect(result.ok).toBe(true);
    expect(result.index!.present).toBe(false);
    expect(formatVerify(result)).toContain("not covered by any index");
  });

  it("keeps the index chain valid when sessions close concurrently", async () => {
    const dir = tempDir();
    // Each session writes exactly one index line, under the lock.
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        Promise.resolve().then(() => openLater(dir, `tool-${index}`)),
      ),
    );

    const lines = readIndexEntries(indexPath(dir));
    expect(lines).toHaveLength(8);
    expect(lines.map((line) => line.entry!.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(check(dir, journalsIn(dir)).ok).toBe(true);
  });
});

describe("facts collected while verifying", () => {
  it("records how each journal ended, so the index can confirm it", () => {
    const dir = tempDir();
    const path = session(dir, "read", 3);
    const journals = verifyJournals([{ path, lines: readJournalLines(path) }]);
    const facts: JournalFacts = journals.facts.get(path)!;

    expect(facts.entries).toBe(3);
    expect(facts.lastHash).toBe(readJournalLines(path).at(-1)!.entry!.hash);
  });
});
