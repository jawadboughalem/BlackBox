import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

interface Result {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

/** Runs a command, feeds it `input`, and collects raw stdout. */
function run(command: string[], input: Buffer | string = ""): Promise<Result> {
  const child = spawn(process.execPath, command, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);

  return new Promise((resolve) => {
    child.on("close", (code) =>
      resolve({ stdout: Buffer.concat(stdout), stderr, code }),
    );
  });
}

/** The same server run directly, with no proxy in between. */
const direct = (serverArgs: string[] = [], input: Buffer | string = "") =>
  run([SERVER, ...serverArgs], input);

/** The same server run behind `mcp-blackbox -- ...`. */
const proxied = (serverArgs: string[] = [], input: Buffer | string = "") =>
  run([CLI, "--", process.execPath, SERVER, ...serverArgs], input);

const rpc = (id: number, method: string, params?: unknown) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`;

const INITIALIZE = rpc(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
});
const TOOLS_CALL = rpc(2, "tools/call", { name: "echo", arguments: { text: "hi" } });

const lines = (buffer: Buffer) =>
  buffer.toString("utf8").split("\n").filter((line) => line !== "");

describe.skipIf(!existsSync(CLI))("proxy mode", () => {
  it("relays an initialize round-trip", async () => {
    const { stdout, code } = await proxied([], INITIALIZE);
    const [response] = lines(stdout).map((line) => JSON.parse(line));
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "fake-mcp-server" } },
    });
    expect(code).toBe(0);
  });

  it("relays a tools/call round-trip", async () => {
    const { stdout } = await proxied([], INITIALIZE + TOOLS_CALL);
    const responses = lines(stdout).map((line) => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatchObject({
      id: 2,
      result: { content: [{ type: "text", text: "called echo" }] },
    });
  });

  // The core guarantee: proxied output must be indistinguishable from running
  // the server directly. This covers byte transparency and the rule that
  // nothing but relayed traffic reaches stdout, in one assertion.
  describe("is indistinguishable from running the server directly", () => {
    const cases: Array<[string, string[], Buffer | string]> = [
      ["a normal session", [], INITIALIZE + TOOLS_CALL],
      ["no input at all", [], ""],
      ["non-JSON output from the server", ["--emit-garbage"], INITIALIZE],
      ["output with no trailing newline", ["--no-trailing-newline"], INITIALIZE],
      ["malformed input echoed back", [], 'this is not json\n'],
      ["blank lines in the stream", [], `\n\n${INITIALIZE}\n`],
      ["invalid utf-8 in the stream", [], Buffer.from([0xff, 0xfe, 0x41, 0x0a])],
      ["a large burst", [], INITIALIZE.repeat(200)],
    ];

    it.each(cases)("matches for %s", async (_label, serverArgs, input) => {
      const [a, b] = await Promise.all([
        direct(serverArgs, input),
        proxied(serverArgs, input),
      ]);
      expect(b.stdout.equals(a.stdout)).toBe(true);
      expect(b.code).toBe(a.code);
    });
  });

  it("passes a malformed line through byte for byte", async () => {
    const { stdout } = await proxied(["--emit-garbage"], "");
    expect(stdout.subarray(0, 25).toString()).toBe('this is not json {"half":');
  });

  it("propagates the child's exit code", async () => {
    const { code } = await proxied(["--exit-code", "3"], INITIALIZE);
    expect(code).toBe(3);
  });

  it("propagates a zero exit code", async () => {
    const { code } = await proxied([], INITIALIZE);
    expect(code).toBe(0);
  });

  it("relays the child's stderr without touching stdout", async () => {
    const { stdout, stderr } = await proxied(["--log", "server starting"], "");
    expect(stderr).toContain("server starting");
    expect(stdout).toHaveLength(0);
  });

  const MISSING = "definitely-not-a-real-command-xyz";

  it("reports a command that cannot be run, on stderr only", async () => {
    const { stdout, stderr, code } = await run([CLI, "--", MISSING]);
    expect(stdout).toHaveLength(0);
    expect(stderr.trim()).not.toBe("");
    expect(code).not.toBe(0);
  });

  // On Windows the command goes through cmd.exe, which reports the failure
  // itself and returns its own exit code, so only the invariants above hold.
  it.skipIf(process.platform === "win32")(
    "uses the conventional not-found exit code",
    async () => {
      const { stderr, code } = await run([CLI, "--", MISSING]);
      expect(stderr).toContain("mcp-blackbox:");
      expect(code).toBe(127);
    },
  );

  // Exercises the Windows shell path end to end: `npm` is a .cmd shim there,
  // the same shape as the `npx` invocation a real MCP server is launched with.
  it("relays a command that is a shell shim on Windows", async () => {
    const { stdout, code } = await run([CLI, "--", "npm", "--version"]);
    expect(stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(code).toBe(0);
  }, 30_000);
});

// Windows has no real signals: `kill` there terminates the process outright,
// so the forwarding path cannot be observed.
describe.skipIf(!existsSync(CLI) || process.platform === "win32")(
  "proxy signal handling",
  () => {
    /** Starts a proxied server and leaves stdin open so it keeps running. */
    function startLongLived(serverArgs: string[] = []) {
      const child = spawn(
        process.execPath,
        [CLI, "--", process.execPath, SERVER, ...serverArgs],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => child.on("close", (code, signal) => resolve({ code, signal })),
      );
      return { child, exited };
    }

    it("forwards SIGINT and exits 130", async () => {
      const { child, exited } = startLongLived();
      child.stdin.write(INITIALIZE);
      await new Promise((r) => child.stdout.once("data", r));
      child.kill("SIGINT");
      expect((await exited).code).toBe(130);
    });

    it("forwards SIGTERM and exits 143", async () => {
      const { child, exited } = startLongLived();
      child.stdin.write(INITIALIZE);
      await new Promise((r) => child.stdout.once("data", r));
      child.kill("SIGTERM");
      expect((await exited).code).toBe(143);
    });

    it("kills a child that ignores the signal", async () => {
      const { child, exited } = startLongLived(["--ignore-signals"]);
      child.stdin.write(INITIALIZE);
      await new Promise((r) => child.stdout.once("data", r));
      child.kill("SIGINT");
      // SIGKILL after the grace period: 128 + 9.
      expect((await exited).code).toBe(137);
    }, 15_000);
  },
);
