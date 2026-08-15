import { describe, expect, it } from "vitest";
import { EXIT_USAGE, runCli, type CliContext } from "../src/run.js";

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: "/workspace",
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
    expect(h.stdout()).toContain("path: sessions/a.jsonl");
    expect(h.stdout()).toContain("resolved: /workspace/sessions/a.jsonl");
  });

  it("defaults the summary path to the working directory", () => {
    const h = harness();
    expect(runCli(["summary"], h.context)).toBe(0);
    expect(h.stdout()).toContain("mode: summary");
    expect(h.stdout()).toContain("resolved: /workspace");
  });

  it("writes usage errors to stderr and exits non-zero", () => {
    const h = harness();
    expect(runCli(["replay"], h.context)).toBe(EXIT_USAGE);
    expect(h.stderr()).toContain("error: Unknown command: replay");
    expect(h.stderr()).toContain("Usage:");
    expect(h.stdout()).toBe("");
  });
});
