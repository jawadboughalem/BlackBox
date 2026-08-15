import { dirname } from "node:path";
import type { JournalLine } from "./journal-reader.js";

export interface GroupStats {
  name: string;
  calls: number;
  failures: number;
}

export interface Summary {
  /** Journals the figures come from; each proxy session writes its own. */
  files: string[];
  /** Entries that could be read; unreadable lines are counted separately. */
  calls: number;
  skipped: number;
  period: { from: string | null; to: string | null };
  failures: number;
  /** Share of calls that failed, 0 to 1. Zero when there are no calls. */
  failure_rate: number;
  duration_ms: { median: number; p95: number };
  by_tool: GroupStats[];
  by_server: GroupStats[];
}

/**
 * Aggregates one or more journals. Unreadable lines are skipped, not fatal:
 * reporting that a chain is damaged is `verify`'s job.
 */
export function summarise(lines: Iterable<JournalLine>, files: string[]): Summary {
  // Accumulated in one pass rather than from a materialised list: only the
  // durations are kept, since percentiles need them all.
  const durations: number[] = [];
  const byTool = new Map<string, GroupStats>();
  const byServer = new Map<string, GroupStats>();
  let calls = 0;
  let skipped = 0;
  let failures = 0;
  let from: string | null = null;
  let to: string | null = null;

  for (const line of lines) {
    const entry = line.entry;
    if (entry === null) {
      skipped += 1;
      continue;
    }

    calls += 1;
    durations.push(entry.duration_ms);
    if (entry.outcome === "error") failures += 1;
    if (from === null || entry.ts < from) from = entry.ts;
    if (to === null || entry.ts > to) to = entry.ts;
    count(byTool, entry.tool, entry.outcome);
    count(byServer, entry.server, entry.outcome);
  }

  durations.sort((a, b) => a - b);

  return {
    files,
    calls,
    skipped,
    period: { from, to },
    failures,
    failure_rate: calls === 0 ? 0 : failures / calls,
    duration_ms: { median: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
    by_tool: ranked(byTool),
    by_server: ranked(byServer),
  };
}

/**
 * Nearest-rank percentile over a sorted list: the smallest value at or above
 * the requested share. No interpolation, so every result is a duration that
 * was actually observed.
 */
export function percentile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(share * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] ?? 0;
}

function count(totals: Map<string, GroupStats>, name: string, outcome: "ok" | "error"): void {
  const stats = totals.get(name) ?? { name, calls: 0, failures: 0 };
  stats.calls += 1;
  if (outcome === "error") stats.failures += 1;
  totals.set(name, stats);
}

/** Busiest first, ties broken on name so the output is stable. */
function ranked(totals: Map<string, GroupStats>): GroupStats[] {
  return [...totals.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/** Renders the summary the way the CLI prints it. */
export function formatSummary(summary: Summary): string {
  const header =
    summary.files.length === 1
      ? (summary.files[0] ?? "")
      : `${dirname(summary.files[0] ?? "")}  (${summary.files.length} sessions)`;
  const lines: string[] = [header, ""];

  if (summary.calls === 0) {
    lines.push("No calls recorded.");
    if (summary.skipped > 0) lines.push(`${summary.skipped} unreadable line(s) skipped.`);
    return lines.join("\n");
  }

  const percent = `${(summary.failure_rate * 100).toFixed(1)}%`;
  lines.push(
    `Period    ${summary.period.from} → ${summary.period.to}`,
    `Calls     ${summary.calls} (${summary.failures} failed, ${percent})`,
    `Duration  median ${summary.duration_ms.median} ms · p95 ${summary.duration_ms.p95} ms`,
  );

  if (summary.skipped > 0) {
    lines.push(`Skipped   ${summary.skipped} unreadable line(s)`);
  }

  lines.push("", "By tool", ...table(summary.by_tool));
  lines.push("", "By server", ...table(summary.by_server));

  return lines.join("\n");
}

function table(groups: readonly GroupStats[]): string[] {
  const width = Math.max(0, ...groups.map((group) => group.name.length));
  return groups.map((group) => {
    const failures = group.failures === 0 ? "" : `  ${group.failures} failed`;
    return `  ${group.name.padEnd(width)}  ${String(group.calls).padStart(5)}${failures}`;
  });
}
