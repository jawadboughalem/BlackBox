import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs — help and version", () => {
  it("shows help when called with no arguments", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
  });

  it.each(["-h", "--help", "help"])("treats %s as help", (flag) => {
    expect(parseArgs([flag])).toEqual({ kind: "help" });
  });

  it.each(["-v", "-V", "--version", "version"])(
    "treats %s as version",
    (flag) => {
      expect(parseArgs([flag])).toEqual({ kind: "version" });
    },
  );
});

describe("parseArgs — proxy mode", () => {
  it("captures the server command after `--`", () => {
    expect(parseArgs(["--", "node", "server.js"])).toEqual({
      kind: "proxy",
      command: "node",
      args: ["server.js"],
    });
  });

  it("accepts a bare command with no arguments", () => {
    expect(parseArgs(["--", "my-server"])).toEqual({
      kind: "proxy",
      command: "my-server",
      args: [],
    });
  });

  it("passes the server's own flags through verbatim", () => {
    const argv = ["--", "npx", "-y", "some-server", "--port", "1234", "--help"];
    expect(parseArgs(argv)).toEqual({
      kind: "proxy",
      command: "npx",
      args: ["-y", "some-server", "--port", "1234", "--help"],
    });
  });

  it("does not treat a later `--` as a new separator", () => {
    expect(parseArgs(["--", "server", "--", "extra"])).toEqual({
      kind: "proxy",
      command: "server",
      args: ["--", "extra"],
    });
  });

  it("does not treat a server named like a subcommand as a subcommand", () => {
    expect(parseArgs(["--", "verify"])).toEqual({
      kind: "proxy",
      command: "verify",
      args: [],
    });
  });

  it("errors when `--` is not followed by a command", () => {
    const parsed = parseArgs(["--"]);
    expect(parsed.kind).toBe("error");
    expect(parsed).toMatchObject({ message: expect.stringContaining("`--`") });
  });
});

describe("parseArgs — verify and summary", () => {
  // A null path means "not given"; the command turns that into the default
  // journal, which the parser has no business knowing about.
  it.each(["verify", "summary"] as const)("leaves the %s path unset when omitted", (name) => {
    expect(parseArgs([name])).toEqual({ kind: name, path: null, json: false });
  });

  it.each(["verify", "summary"] as const)("reads the %s path", (name) => {
    expect(parseArgs([name, "./sessions/run.jsonl"])).toEqual({
      kind: name,
      path: "./sessions/run.jsonl",
      json: false,
    });
  });

  it("accepts an absolute path", () => {
    expect(parseArgs(["summary", "/var/log/blackbox"])).toEqual({
      kind: "summary",
      path: "/var/log/blackbox",
      json: false,
    });
  });

  it.each(["verify", "summary"] as const)("accepts --json for %s", (name) => {
    expect(parseArgs([name, "--json"])).toEqual({ kind: name, path: null, json: true });
  });

  it("accepts a path and --json in either order", () => {
    const expected = { kind: "verify", path: "a.jsonl", json: true };
    expect(parseArgs(["verify", "a.jsonl", "--json"])).toEqual(expected);
    expect(parseArgs(["verify", "--json", "a.jsonl"])).toEqual(expected);
  });

  it("rejects more than one path", () => {
    const parsed = parseArgs(["verify", "a.jsonl", "b.jsonl"]);
    expect(parsed.kind).toBe("error");
    expect(parsed).toMatchObject({
      message: expect.stringContaining("at most one path"),
    });
  });

  it("rejects unknown options on a subcommand", () => {
    expect(parseArgs(["verify", "--csv"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--csv"),
    });
  });

  it("rejects a trailing `--` on a subcommand", () => {
    expect(parseArgs(["verify", "--", "node"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("parseArgs — invalid input", () => {
  it("rejects an unknown command", () => {
    expect(parseArgs(["replay"])).toEqual({
      kind: "error",
      message: "Unknown command: replay",
    });
  });

  it("rejects an unknown option", () => {
    expect(parseArgs(["--verbose"])).toEqual({
      kind: "error",
      message: "Unknown option: --verbose",
    });
  });

  it("does not mutate the input array", () => {
    const argv = ["--", "node", "server.js"];
    parseArgs(argv);
    expect(argv).toEqual(["--", "node", "server.js"]);
  });
});
