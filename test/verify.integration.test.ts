import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

interface Result {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/** Records a real session through the proxy and returns its journal. */
function record(calls: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "blackbox-e2e-"));
  let input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
  for (let index = 0; index < calls; index += 1) {
    input += `${JSON.stringify({
      jsonrpc: "2.0",
      id: index + 2,
      method: "tools/call",
      params: { name: index % 4 === 0 ? "tool-error" : `tool-${index % 3}`, arguments: { index } },
    })}\n`;
  }

  const child = spawn(process.execPath, [CLI, "--", process.execPath, SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCP_BLACKBOX_DIR: dir },
  });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end(input);
  return new Promise((resolve) => child.on("close", () => resolve(dir)));
}

const journalOf = (dir: string) => join(dir, "journal.jsonl");

function readEntries(dir: string): JournalEntry[] {
  return readFileSync(journalOf(dir), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalEntry);
}

function writeEntries(dir: string, entries: unknown[]): void {
  writeFileSync(journalOf(dir), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

describe.skipIf(!existsSync(CLI))("verify (end to end)", () => {
  it("accepts a journal it recorded itself", async () => {
    const dir = await record(12);
    const { stdout, code } = await run(["verify", journalOf(dir)]);
    expect(stdout.trim()).toBe("OK — 12 entries, chain intact");
    expect(code).toBe(0);
  }, 20_000);

  it("finds the journal from MCP_BLACKBOX_DIR with no path given", async () => {
    const dir = await record(3);
    const { stdout, code } = await run(["verify"], { MCP_BLACKBOX_DIR: dir });
    expect(stdout).toContain("3 entries, chain intact");
    expect(code).toBe(0);
  }, 20_000);

  it("accepts a directory instead of a file", async () => {
    const dir = await record(2);
    const { code } = await run(["verify", dir]);
    expect(code).toBe(0);
  }, 20_000);

  it("reports a tampered entry and exits 1", async () => {
    const dir = await record(6);
    const entries = readEntries(dir);
    entries[3]!.tool = "tampered";
    writeEntries(dir, entries);

    const { stdout, code } = await run(["verify", journalOf(dir)]);
    expect(stdout).toContain("BROKEN at entry 4 (seq 4)");
    expect(stdout).toContain("recomputed hash");
    expect(code).toBe(1);
  }, 20_000);

  it("reports a deleted entry and exits 1", async () => {
    const dir = await record(5);
    const entries = readEntries(dir);
    entries.splice(1, 1);
    writeEntries(dir, entries);

    const { stdout, code } = await run(["verify", journalOf(dir)]);
    expect(stdout).toContain("BROKEN at entry 2");
    expect(code).toBe(1);
  }, 20_000);

  it("reports a corrupt line and exits 1", async () => {
    const dir = await record(3);
    writeFileSync(journalOf(dir), `${readFileSync(journalOf(dir), "utf8")}{"seq":4,\n`);

    const { stdout, code } = await run(["verify", journalOf(dir)]);
    expect(stdout).toContain("BROKEN at entry 4 (unreadable)");
    expect(code).toBe(1);
  }, 20_000);

  it("exits 1 with a message when there is no journal", async () => {
    const { stderr, code } = await run(["verify", join(tmpdir(), "absent-journal-xyz.jsonl")]);
    expect(stderr).toContain("no journal at");
    expect(code).toBe(1);
  });

  it("emits JSON with --json", async () => {
    const dir = await record(4);
    const { stdout, code } = await run(["verify", journalOf(dir), "--json"]);
    expect(JSON.parse(stdout)).toEqual({ ok: true, path: journalOf(dir), entries: 4 });
    expect(code).toBe(0);
  }, 20_000);

  it("emits a machine-readable break with --json", async () => {
    const dir = await record(4);
    const entries = readEntries(dir);
    entries[2]!.duration_ms = 99_999;
    writeEntries(dir, entries);

    const { stdout, code } = await run(["verify", journalOf(dir), "--json"]);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, index: 3, seq: 3, verified: 2 });
    expect(code).toBe(1);
  }, 20_000);
});

describe.skipIf(!existsSync(CLI))("summary (end to end)", () => {
  it("summarises a recorded session", async () => {
    const dir = await record(12);
    const { stdout, code } = await run(["summary", journalOf(dir)]);

    expect(stdout).toContain("Calls     12");
    expect(stdout).toContain("By tool");
    expect(stdout).toContain("By server");
    expect(stdout).toContain("fake-mcp-server");
    expect(stdout).toContain("failed");
    expect(code).toBe(0);
  }, 20_000);

  it("emits JSON with --json", async () => {
    const dir = await record(8);
    const { stdout, code } = await run(["summary", journalOf(dir), "--json"]);
    const summary = JSON.parse(stdout);

    expect(summary).toMatchObject({ path: journalOf(dir), calls: 8, skipped: 0 });
    expect(summary.by_server).toEqual([
      { name: "fake-mcp-server", calls: 8, failures: expect.any(Number) },
    ]);
    expect(summary.period.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(summary.duration_ms).toHaveProperty("p95");
    expect(code).toBe(0);
  }, 20_000);

  // A damaged journal is still worth summarising: verify is what reports it.
  it("summarises what it can from a damaged journal", async () => {
    const dir = await record(5);
    writeFileSync(journalOf(dir), `${readFileSync(journalOf(dir), "utf8")}not json at all\n`);

    const { stdout, code } = await run(["summary", journalOf(dir), "--json"]);
    expect(JSON.parse(stdout)).toMatchObject({ calls: 5, skipped: 1 });
    expect(code).toBe(0);
  }, 20_000);

  it("exits 1 when there is no journal", async () => {
    const { stderr, code } = await run(["summary", join(tmpdir(), "absent-journal-xyz.jsonl")]);
    expect(stderr).toContain("no journal at");
    expect(code).toBe(1);
  });
});
