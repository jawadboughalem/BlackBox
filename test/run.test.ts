import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_USAGE, runCli, type CliContext } from "../src/run.js";

// Path expectations go through `resolve` rather than hard-coded literals: the
// separator and the drive prefix differ between POSIX and Windows, and the
// point of these tests is that the CLI resolves against `cwd` at all.
const CWD = resolve("/workspace");

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: CWD,
    version: "9.9.9",
  };
  return {
    context,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

describe("runCli", () => {
  it("prints usage and exits 0 with no arguments", () => {
    const h = harness();
    expect(runCli([], h.context)).toBe(0);
    expect(h.stdout()).toContain("Usage:");
    expect(h.stderr()).toBe("");
  });

  it("prints the version", () => {
    const h = harness();
    expect(runCli(["--version"], h.context)).toBe(0);
    expect(h.stdout()).toBe("9.9.9");
  });

  it("reports the server command it would proxy", () => {
    const h = harness();
    expect(runCli(["--", "node", "server.js", "--port", "3000"], h.context)).toBe(0);
    expect(h.stdout()).toContain("mode: proxy");
    expect(h.stdout()).toContain("command: node");
    expect(h.stdout()).toContain('args: "server.js" "--port" "3000"');
  });

  it("reports an empty argument list explicitly", () => {
    const h = harness();
    runCli(["--", "my-server"], h.context);
    expect(h.stdout()).toContain("args: (none)");
  });

  it("resolves the verify path against the working directory", () => {
    const h = harness();
    expect(runCli(["verify", "sessions/a.jsonl"], h.context)).toBe(0);
    expect(h.stdout()).toContain("mode: verify");
    // The path is echoed as given, and separately resolved to an absolute one.
    expect(h.stdout()).toContain("path: sessions/a.jsonl");
    const resolved = resolve(CWD, "sessions/a.jsonl");
    expect(isAbsolute(resolved)).toBe(true);
    expect(h.stdout()).toContain(`resolved: ${resolved}`);
  });

  it("defaults the summary path to the working directory", () => {
    const h = harness();
    expect(runCli(["summary"], h.context)).toBe(0);
    expect(h.stdout()).toContain("mode: summary");
    expect(h.stdout()).toContain("path: .");
    expect(h.stdout()).toContain(`resolved: ${CWD}`);
  });

  it("writes usage errors to stderr and exits non-zero", () => {
    const h = harness();
    expect(runCli(["replay"], h.context)).toBe(EXIT_USAGE);
    expect(h.stderr()).toContain("error: Unknown command: replay");
    expect(h.stderr()).toContain("Usage:");
    expect(h.stdout()).toBe("");
  });
});
