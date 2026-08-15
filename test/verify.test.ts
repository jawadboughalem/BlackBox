import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH } from "../src/canonical-json.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import { readJournalLines, resolveJournalTarget } from "../src/journal-reader.js";
import { formatVerify, verifyChain } from "../src/verify.js";

/** Builds a genuine journal of `count` entries, then hands back its lines. */
function buildJournal(count: number): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "blackbox-verify-"));
  const journal = Journal.open({ env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv });
  for (let index = 0; index < count; index += 1) {
    journal.record({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      server: index % 2 === 0 ? "server-a" : "server-b",
      tool: `tool-${index % 3}`,
      args_redacted: { index },
      args_hash: `sha256:${"a".repeat(64)}`,
      outcome: index % 5 === 0 ? "error" : "ok",
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

describe("resolveJournalTarget", () => {
  it("falls back to the configured journal when no path is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "blackbox-verify-"));
    const target = resolveJournalTarget(null, { env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv });
    expect(target).toBe(join(dir, "journal.jsonl"));
  });

  it("appends journal.jsonl to a directory", () => {
    const { dir } = buildJournal(1);
    expect(resolveJournalTarget(dir)).toBe(join(dir, "journal.jsonl"));
  });

  it("takes a file path as it is", () => {
    const { path } = buildJournal(1);
    expect(resolveJournalTarget(path)).toBe(path);
  });
});

describe("verifyChain — intact journals", () => {
  it("accepts a single entry", () => {
    const { path } = buildJournal(1);
    expect(verify(path)).toEqual({ ok: true, path, entries: 1 });
  });

  it("accepts 100 entries", () => {
    const { path } = buildJournal(100);
    expect(verify(path)).toEqual({ ok: true, path, entries: 100 });
  });

  it("accepts an empty journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "blackbox-verify-"));
    const path = join(dir, "journal.jsonl");
    writeFileSync(path, "");
    expect(verify(path)).toEqual({ ok: true, path, entries: 0 });
  });

  it("ignores blank lines between entries", () => {
    const { path } = buildJournal(3);
    const entries = entriesOf(path);
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n\n")}\n`);
    expect(verify(path).ok).toBe(true);
  });

  it("reports OK in the expected form", () => {
    const { path } = buildJournal(42);
    expect(formatVerify(verify(path))).toBe("OK — 42 entries, chain intact");
  });

  it("uses the singular for one entry", () => {
    const { path } = buildJournal(1);
    expect(formatVerify(verify(path))).toBe("OK — 1 entry, chain intact");
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

    const text = formatVerify(verify(path));
    expect(text).toContain("BROKEN at entry 2 (seq 2)");
    expect(text).toContain(`${path}:2`);
    expect(text).toContain("1 entry verified before the break");
  });

  it("keeps the genesis hash as the anchor", () => {
    const { path } = buildJournal(1);
    expect(entriesOf(path)[0]!.prev_hash).toBe(GENESIS_HASH);
  });
});
