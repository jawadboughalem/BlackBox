import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal.js";
import type { JournalLine } from "../src/journal-reader.js";
import { formatSummary, percentile, summarise } from "../src/summary.js";

let counter = 0;

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  counter += 1;
  return {
    seq: counter,
    ts: `2026-01-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    server: "server-a",
    tool: "read",
    args_redacted: {},
    args_hash: `sha256:${"a".repeat(64)}`,
    outcome: "ok",
    error_message: null,
    duration_ms: 10,
    result_hash: `sha256:${"b".repeat(64)}`,
    prev_hash: `sha256:${"0".repeat(64)}`,
    hash: `sha256:${"c".repeat(64)}`,
    ...overrides,
  };
}

const asLines = (entries: JournalEntry[]): JournalLine[] =>
  entries.map((item, index) => ({ line: index + 1, entry: item, problem: null }));

const summaryOf = (entries: JournalEntry[]) => summarise(asLines(entries), "/tmp/journal.jsonl");

describe("percentile", () => {
  it("returns 0 for an empty list", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("returns the only value for a single sample", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("uses nearest rank, so results are values that were observed", () => {
    const sorted = [1, 2, 3, 4];
    expect(percentile(sorted, 0.5)).toBe(2);
    expect(percentile(sorted, 0.95)).toBe(4);
  });

  it("computes p95 over 100 samples", () => {
    const sorted = Array.from({ length: 100 }, (_unused, index) => index + 1);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 0.5)).toBe(50);
  });
});

describe("summarise", () => {
  it("counts calls and failures", () => {
    const summary = summaryOf([
      entry(),
      entry({ outcome: "error", error_message: "boom" }),
      entry(),
      entry(),
    ]);
    expect(summary.calls).toBe(4);
    expect(summary.failures).toBe(1);
    expect(summary.failure_rate).toBeCloseTo(0.25);
  });

  it("covers the period from first to last timestamp", () => {
    const summary = summaryOf([
      entry({ ts: "2026-03-02T10:00:00.000Z" }),
      entry({ ts: "2026-03-01T09:00:00.000Z" }),
      entry({ ts: "2026-03-03T11:00:00.000Z" }),
    ]);
    expect(summary.period).toEqual({
      from: "2026-03-01T09:00:00.000Z",
      to: "2026-03-03T11:00:00.000Z",
    });
  });

  it("groups by tool, busiest first", () => {
    const summary = summaryOf([
      entry({ tool: "read" }),
      entry({ tool: "write" }),
      entry({ tool: "read" }),
      entry({ tool: "read", outcome: "error" }),
    ]);
    expect(summary.by_tool).toEqual([
      { name: "read", calls: 3, failures: 1 },
      { name: "write", calls: 1, failures: 0 },
    ]);
  });

  it("groups by server", () => {
    const summary = summaryOf([
      entry({ server: "alpha" }),
      entry({ server: "beta" }),
      entry({ server: "beta" }),
    ]);
    expect(summary.by_server).toEqual([
      { name: "beta", calls: 2, failures: 0 },
      { name: "alpha", calls: 1, failures: 0 },
    ]);
  });

  it("breaks ties on name so output is stable", () => {
    const summary = summaryOf([entry({ tool: "zebra" }), entry({ tool: "alpha" })]);
    expect(summary.by_tool.map((group) => group.name)).toEqual(["alpha", "zebra"]);
  });

  it("computes median and p95 durations", () => {
    const durations = [5, 10, 15, 20, 500];
    const summary = summaryOf(durations.map((duration_ms) => entry({ duration_ms })));
    expect(summary.duration_ms.median).toBe(15);
    expect(summary.duration_ms.p95).toBe(500);
  });

  it("sorts durations before taking percentiles", () => {
    const summary = summaryOf([100, 1, 50].map((duration_ms) => entry({ duration_ms })));
    expect(summary.duration_ms.median).toBe(50);
  });

  it("handles an empty journal without dividing by zero", () => {
    const summary = summaryOf([]);
    expect(summary).toMatchObject({
      calls: 0,
      failures: 0,
      failure_rate: 0,
      period: { from: null, to: null },
      duration_ms: { median: 0, p95: 0 },
      by_tool: [],
      by_server: [],
    });
  });

  it("skips unreadable lines instead of failing", () => {
    const lines: JournalLine[] = [
      { line: 1, entry: entry(), problem: null },
      { line: 2, entry: null, problem: "JSON invalide" },
      { line: 3, entry: entry({ outcome: "error" }), problem: null },
    ];
    const summary = summarise(lines, "/tmp/journal.jsonl");
    expect(summary.calls).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.failure_rate).toBeCloseTo(0.5);
  });

  it("reports a 100% failure rate when everything failed", () => {
    const summary = summaryOf([entry({ outcome: "error" }), entry({ outcome: "error" })]);
    expect(summary.failure_rate).toBe(1);
  });
});

describe("formatSummary", () => {
  it("shows the period, counts and durations", () => {
    const summary = summaryOf([
      entry({ ts: "2026-03-01T09:00:00.000Z", duration_ms: 10, tool: "read" }),
      entry({ ts: "2026-03-01T10:00:00.000Z", duration_ms: 90, tool: "write", outcome: "error" }),
    ]);
    const text = formatSummary(summary);

    expect(text).toContain("2026-03-01T09:00:00.000Z → 2026-03-01T10:00:00.000Z");
    expect(text).toContain("Appels    2 (1 en échec, 50.0 %)");
    // Nearest rank over [10, 90]: the median is the lower sample, not the mean.
    expect(text).toContain("médiane 10 ms · p95 90 ms");
    expect(text).toContain("Par outil");
    expect(text).toContain("Par serveur");
    expect(text).toContain("read");
    expect(text).toContain("write");
  });

  it("says so when nothing was recorded", () => {
    expect(formatSummary(summaryOf([]))).toContain("Aucun appel enregistré.");
  });

  it("mentions skipped lines", () => {
    const summary = summarise(
      [
        { line: 1, entry: entry(), problem: null },
        { line: 2, entry: null, problem: "JSON invalide" },
      ],
      "/tmp/journal.jsonl",
    );
    expect(formatSummary(summary)).toContain("1 ligne(s) illisible(s)");
  });

  it("names the journal it read", () => {
    expect(formatSummary(summaryOf([entry()]))).toContain("/tmp/journal.jsonl");
  });
});
