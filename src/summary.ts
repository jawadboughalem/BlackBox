import type { JournalEntry } from "./journal.js";
import type { JournalLine } from "./journal-reader.js";

export interface GroupStats {
  name: string;
  calls: number;
  failures: number;
}

export interface Summary {
  path: string;
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

/** Aggregates the journal. Unreadable lines are skipped, not fatal. */
export function summarise(lines: readonly JournalLine[], path: string): Summary {
  const entries = lines
    .map((line) => line.entry)
    .filter((entry): entry is JournalEntry => entry !== null);

  const failures = entries.filter((entry) => entry.outcome === "error").length;
  const timestamps = entries.map((entry) => entry.ts).sort();
  const durations = entries.map((entry) => entry.duration_ms).sort((a, b) => a - b);

  return {
    path,
    calls: entries.length,
    skipped: lines.length - entries.length,
    period: { from: timestamps.at(0) ?? null, to: timestamps.at(-1) ?? null },
    failures,
    failure_rate: entries.length === 0 ? 0 : failures / entries.length,
    duration_ms: { median: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
    by_tool: group(entries, (entry) => entry.tool),
    by_server: group(entries, (entry) => entry.server),
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

/** Counts calls and failures per key, busiest first. */
function group(entries: readonly JournalEntry[], key: (entry: JournalEntry) => string): GroupStats[] {
  const totals = new Map<string, GroupStats>();

  for (const entry of entries) {
    const name = key(entry);
    const stats = totals.get(name) ?? { name, calls: 0, failures: 0 };
    stats.calls += 1;
    if (entry.outcome === "error") stats.failures += 1;
    totals.set(name, stats);
  }

  return [...totals.values()].sort(
    (a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
  );
}

/** Renders the summary the way the CLI prints it. */
export function formatSummary(summary: Summary): string {
  const lines: string[] = [summary.path, ""];

  if (summary.calls === 0) {
    lines.push("Aucun appel enregistré.");
    if (summary.skipped > 0) lines.push(`${summary.skipped} ligne(s) illisible(s) ignorée(s).`);
    return lines.join("\n");
  }

  const percent = `${(summary.failure_rate * 100).toFixed(1)} %`;
  lines.push(
    `Période   ${summary.period.from} → ${summary.period.to}`,
    `Appels    ${summary.calls} (${summary.failures} en échec, ${percent})`,
    `Durée     médiane ${summary.duration_ms.median} ms · p95 ${summary.duration_ms.p95} ms`,
  );

  if (summary.skipped > 0) {
    lines.push(`Ignorées  ${summary.skipped} ligne(s) illisible(s)`);
  }

  lines.push("", "Par outil", ...table(summary.by_tool));
  lines.push("", "Par serveur", ...table(summary.by_server));

  return lines.join("\n");
}

function table(groups: readonly GroupStats[]): string[] {
  const width = Math.max(0, ...groups.map((group) => group.name.length));
  return groups.map((group) => {
    const failures = group.failures === 0 ? "" : `  ${group.failures} en échec`;
    return `  ${group.name.padEnd(width)}  ${String(group.calls).padStart(5)}${failures}`;
  });
}
