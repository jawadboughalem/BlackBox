import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH } from "../src/canonical-json.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import {
  iterateJournalLines,
  readJournalLines,
  resolveJournalTargets,
} from "../src/journal-reader.js";
import { formatVerify, verifyChain, verifyJournals } from "../src/verify.js";

/** Builds a genuine journal of `count` entries, then hands back its lines. */
function buildJournal(count: number): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "blackbox-verify-"));
  const journal = Journal.openAt(join(dir, "journal.jsonl"));
  for (let index = 0; index < count; index += 1) {
    journal.record({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      server: index % 2 === 0 ? "server-a" : "server-b",
      tool: `tool-${index % 3}`,
      args_redacted: { index },
      args_hash: `sha256:${"a".repeat(64)}`,
      outcome: index % 5 === 0 ? "error" : "ok",
      error_kind: index % 5 === 0 ? "protocol" : null,
      error_message: index % 5 === 0 ? "boom" : null,
      duration_ms: index,
      result_hash: `sha256:${"b".repeat(64)}`,
    });
  }
  journal.close();
  return { dir, path: join(dir, "journal.jsonl") };
}

function entriesOf(path: string): JournalEntry[] {
  return readJournalLines(path).map((line) => line.entry!);
}

/** Rewrites a journal from entries, so tampering can be expressed directly. */
function writeEntries(path: string, entries: unknown[]): void {
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function verify(path: string) {
  return verifyChain(readJournalLines(path), path);
}

/** The same journal, wrapped as the multi-file result the CLI prints. */
function verifyOne(path: string) {
  return verifyJournals([{ path, lines: readJournalLines(path) }]);
}

describe("resolveJournalTargets", () => {
  it("lists every journal in the configured directory", () => {
    const { dir } = buildJournal(1);
    const targets = resolveJournalTargets(null, {
      env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv,
    });
    expect(targets).toEqual([join(dir, "journal.jsonl")]);
  });

  it("lists every journal in a given directory, in chronological name order", () => {
    const { dir } = buildJournal(1);
    writeFileSync(join(dir, "journal-20260101T000000Z-1.jsonl"), "");
    writeFileSync(join(dir, "journal-20250101T000000Z-1.jsonl"), "");
    writeFileSync(join(dir, "notes.txt"), "ignored");

    expect(resolveJournalTargets(dir).map((path) => path.split(/[\\/]/).at(-1))).toEqual([
      "journal-20250101T000000Z-1.jsonl",
      "journal-20260101T000000Z-1.jsonl",
      "journal.jsonl",
    ]);
  });

  it("takes a file path as it is", () => {
    const { path } = buildJournal(1);
    expect(resolveJournalTargets(path)).toEqual([path]);
  });

  it("reports a directory holding no journals", () => {
    const dir = mkdtempSync(join(tmpdir(), "blackbox-verify-"));
    expect(() => resolveJournalTargets(dir)).toThrow(/no journal/);
  });
});

describe("verifyChain — intact journals", () => {
  it("accepts a single entry", () => {
    const { path } = buildJournal(1);
    expect(verify(path)).toMatchObject({ ok: true, path, entries: 1 });
  });

  it("accepts 100 entries", () => {
    const { path } = buildJournal(100);
    expect(verify(path)).toMatchObject({ ok: true, path, entries: 100 });
  });

  it("accepts an empty journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "blackbox-verify-"));
    const path = join(dir, "journal.jsonl");
    writeFileSync(path, "");
    expect(verify(path)).toMatchObject({ ok: true, path, entries: 0 });
  });

  it("ignores blank lines between entries", () => {
    const { path } = buildJournal(3);
    const entries = entriesOf(path);
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n\n")}\n`);
    expect(verify(path).ok).toBe(true);
  });

  it("reports OK in the expected form", () => {
    const { path } = buildJournal(42);
    expect(formatVerify(verifyOne(path))).toBe("OK — 42 entries, chain intact");
  });

  it("uses the singular for one entry", () => {
    const { path } = buildJournal(1);
    expect(formatVerify(verifyOne(path))).toBe("OK — 1 entry, chain intact");
  });
});

describe("verifyChain — tampered journals", () => {
  it("catches an edited field", () => {
    const { path } = buildJournal(5);
    const entries = entriesOf(path);
    entries[2]!.tool = "something-else";
    writeEntries(path, entries);

    const result = verify(path);
    expect(result).toMatchObject({ ok: false, index: 3, seq: 3, verified: 2 });
    expect(result.ok === false && result.reason).toContain("recomputed hash");
  });

  it("catches an edited argument, even a redacted one", () => {
    const { path } = buildJournal(3);
    const entries = entriesOf(path);
    entries[0]!.args_redacted = { index: 999 };
    writeEntries(path, entries);
    expect(verify(path)).toMatchObject({ ok: false, index: 1, seq: 1 });
  });

  it("catches a re-hashed entry, because the chain no longer matches", () => {
    const { path } = buildJournal(4);
    const entries = entriesOf(path);
    // A forger who recomputes the hash of the entry they edited still leaves
    // the next entry's prev_hash pointing at the old one.
    entries[1]!.duration_ms = 9999;
    const { hash, ...rest } = entries[1]!;
    entries[1]!.hash = `sha256:${"c".repeat(64)}`;
    void hash;
    void rest;
    writeEntries(path, entries);
    expect(verify(path)).toMatchObject({ ok: false, index: 2 });
  });

  it("catches a deleted entry", () => {
    const { path } = buildJournal(5);
    const entries = entriesOf(path);
    entries.splice(2, 1);
    writeEntries(path, entries);

    const result = verify(path);
    expect(result).toMatchObject({ ok: false, index: 3 });
    expect(result.ok === false && result.reason).toContain("expected seq 3, found 4");
  });

  it("catches a duplicated entry", () => {
    const { path } = buildJournal(3);
    const entries = entriesOf(path);
    entries.splice(1, 0, entries[1]!);
    writeEntries(path, entries);
    expect(verify(path)).toMatchObject({ ok: false, index: 3 });
  });

  it("catches reordered entries", () => {
    const { path } = buildJournal(4);
    const entries = entriesOf(path);
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];
    writeEntries(path, entries);
    expect(verify(path)).toMatchObject({ ok: false, index: 2 });
  });

  it("catches a broken prev_hash link", () => {
    const { path } = buildJournal(3);
    const entries = entriesOf(path);
    entries[2]!.prev_hash = `sha256:${"d".repeat(64)}`;
    writeEntries(path, entries);

    const result = verify(path);
    expect(result).toMatchObject({ ok: false, index: 3 });
    expect(result.ok === false && result.reason).toContain("prev_hash");
  });

  it("catches a first entry that does not start from genesis", () => {
    const { path } = buildJournal(2);
    const entries = entriesOf(path);
    entries[0]!.prev_hash = `sha256:${"e".repeat(64)}`;
    writeEntries(path, entries);

    const result = verify(path);
    expect(result).toMatchObject({ ok: false, index: 1 });
    expect(result.ok === false && result.reason).toContain("genesis");
  });

  it("catches a truncated final line", () => {
    const { path } = buildJournal(3);
    const entries = entriesOf(path);
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n{"seq":4,"ts":`);

    const result = verify(path);
    expect(result).toMatchObject({ ok: false, index: 4, seq: null });
    expect(result.ok === false && result.reason).toContain("not valid JSON");
  });

  it("catches an entry missing a required field", () => {
    const { path } = buildJournal(2);
    const entries = entriesOf(path) as Array<Partial<JournalEntry>>;
    delete entries[1]!.result_hash;
    writeEntries(path, entries);

    const result = verify(path);
    expect(result).toMatchObject({ ok: false, index: 2, seq: null });
    expect(result.ok === false && result.reason).toContain("result_hash");
  });

  it("catches an unexpected outcome value", () => {
    const { path } = buildJournal(1);
    const entries = entriesOf(path) as unknown as Array<Record<string, unknown>>;
    entries[0]!["outcome"] = "maybe";
    writeEntries(path, entries);
    expect(verify(path).ok).toBe(false);
  });

  it("stops at the first break, not the last", () => {
    const { path } = buildJournal(6);
    const entries = entriesOf(path);
    entries[1]!.tool = "edited";
    entries[4]!.tool = "edited too";
    writeEntries(path, entries);
    expect(verify(path)).toMatchObject({ index: 2, verified: 1 });
  });

  it("reports the break in the expected form", () => {
    const { path } = buildJournal(3);
    const entries = entriesOf(path);
    entries[1]!.tool = "tampered";
    writeEntries(path, entries);

    const text = formatVerify(verifyOne(path));
    expect(text).toContain("BROKEN at entry 2 (seq 2)");
    expect(text).toContain(`${path}:2`);
    expect(text).toContain("1 entry verified before the break");
  });

  it("keeps the genesis hash as the anchor", () => {
    const { path } = buildJournal(1);
    expect(entriesOf(path)[0]!.prev_hash).toBe(GENESIS_HASH);
  });
});

describe("iterateJournalLines", () => {
  it("yields the same lines as reading the file whole", () => {
    const { path } = buildJournal(20);
    expect([...iterateJournalLines(path)]).toEqual(readJournalLines(path));
  });

  it("numbers lines from 1, counting blanks", () => {
    const { path } = buildJournal(2);
    const entries = entriesOf(path);
    writeFileSync(path, `${JSON.stringify(entries[0])}\n\n${JSON.stringify(entries[1])}\n`);
    expect([...iterateJournalLines(path)].map((line) => line.line)).toEqual([1, 3]);
  });

  it("reassembles entries split across read boundaries", () => {
    // Entries far larger than the 64 KiB read size, so lines certainly span
    // several chunks.
    const dir = mkdtempSync(join(tmpdir(), "blackbox-verify-"));
    const journal = Journal.openAt(join(dir, "journal.jsonl"));
    for (let index = 0; index < 5; index += 1) {
      journal.record({
        ts: "2026-01-01T00:00:00.000Z",
        server: "s",
        tool: "big",
        args_redacted: { blob: "x".repeat(100_000) },
        args_hash: `sha256:${"a".repeat(64)}`,
        outcome: "ok",
        error_kind: null,
        error_message: null,
        duration_ms: 1,
        result_hash: `sha256:${"b".repeat(64)}`,
      });
    }
    journal.close();

    const path = join(dir, "journal.jsonl");
    expect(verify(path)).toMatchObject({ ok: true, path, entries: 5 });
  });

  it("closes the file even when the consumer stops early", () => {
    const { path } = buildJournal(50);
    // Many partial reads would exhaust the descriptor table if the generator
    // leaked one each time.
    for (let index = 0; index < 500; index += 1) {
      const iterator = iterateJournalLines(path);
      iterator.next();
      iterator.return(undefined);
    }
    expect(verify(path).ok).toBe(true);
  });
});
