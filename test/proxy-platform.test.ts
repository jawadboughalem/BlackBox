import { describe, expect, it } from "vitest";
import { needsShell, quoteForCmd } from "../src/proxy.js";

// These two helpers only matter on Windows, so they are tested against an
// explicit platform rather than whatever the suite happens to run on.
describe("needsShell", () => {
  it("never uses a shell on POSIX", () => {
    expect(needsShell("npx", "linux")).toBe(false);
    expect(needsShell("node", "darwin")).toBe(false);
  });

  it("uses a shell on Windows for shim commands", () => {
    // npx/npm are .cmd files, which Node refuses to spawn without a shell.
    expect(needsShell("npx", "win32")).toBe(true);
    expect(needsShell("npm", "win32")).toBe(true);
  });

  it("spawns real executables directly on Windows", () => {
    expect(needsShell("node.exe", "win32")).toBe(false);
    expect(needsShell("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
  });
});

describe("quoteForCmd", () => {
  it("leaves ordinary arguments alone", () => {
    expect(quoteForCmd("--port")).toBe("--port");
    expect(quoteForCmd("server.js")).toBe("server.js");
  });

  it("quotes paths containing spaces", () => {
    expect(quoteForCmd("C:\\My Files\\server.js")).toBe('"C:\\My Files\\server.js"');
  });

  it("quotes shell metacharacters", () => {
    expect(quoteForCmd("a&b")).toBe('"a&b"');
    expect(quoteForCmd("a|b")).toBe('"a|b"');
    expect(quoteForCmd("(x)")).toBe('"(x)"');
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes the empty string so it survives as an argument", () => {
    expect(quoteForCmd("")).toBe('""');
  });
});
