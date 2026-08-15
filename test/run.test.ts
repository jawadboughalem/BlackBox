import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { EXIT_USAGE, runCli, type CliContext } from "../src/run.js";

// Path expectations go through `resolve` rather than hard-coded literals: the
// separator and the drive prefix differ between POSIX and Windows, and the
// point of these tests is that the CLI resolves against `cwd` at all.
const CWD = resolve("/workspace");

function collector() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

function harness() {
  const out = collector();
  const err = collector();
  const context: CliContext = {
    stdin: Readable.from([]),
    stdout: out.stream,
    stderr: err.stream,
    cwd: CWD,
    version: "9.9.9",
  };
  return { context, stdout: out.text, stderr: err.text };
}

describe("runCli", () => {
  it("prints usage and exits 0 with no arguments", async () => {
    const h = harness();
    expect(await runCli([], h.context)).toBe(0);
    expect(h.stdout()).toContain("Usage:");
    expect(h.stderr()).toBe("");
  });

  it("prints the version", async () => {
    const h = harness();
    expect(await runCli(["--version"], h.context)).toBe(0);
    expect(h.stdout().trim()).toBe("9.9.9");
  });

  it("resolves the verify path against the working directory", async () => {
    const h = harness();
    expect(await runCli(["verify", "sessions/a.jsonl"], h.context)).toBe(0);
    expect(h.stdout()).toContain("mode: verify");
    // The path is echoed as given, and separately resolved to an absolute one.
    expect(h.stdout()).toContain("path: sessions/a.jsonl");
    const resolved = resolve(CWD, "sessions/a.jsonl");
    expect(isAbsolute(resolved)).toBe(true);
    expect(h.stdout()).toContain(`resolved: ${resolved}`);
  });

  it("defaults the summary path to the working directory", async () => {
    const h = harness();
    expect(await runCli(["summary"], h.context)).toBe(0);
    expect(h.stdout()).toContain("mode: summary");
    expect(h.stdout()).toContain("path: .");
    expect(h.stdout()).toContain(`resolved: ${CWD}`);
  });

  it("writes usage errors to stderr and exits non-zero", async () => {
    const h = harness();
    expect(await runCli(["replay"], h.context)).toBe(EXIT_USAGE);
    expect(h.stderr()).toContain("error: Unknown command: replay");
    expect(h.stderr()).toContain("Usage:");
    expect(h.stdout()).toBe("");
  });
});
