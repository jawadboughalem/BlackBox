import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, findConfigFile, loadConfig } from "../src/config.js";
import { DEFAULT_MAX_STRING_LENGTH, REDACTED, redact, redactString } from "../src/redact.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "blackbox-config-"));
}

/** Writes a config file and returns a location pointing at it. */
function withConfig(contents: unknown | string) {
  const cwd = tempDir();
  const body = typeof contents === "string" ? contents : JSON.stringify(contents);
  writeFileSync(join(cwd, CONFIG_FILENAME), body);
  return { cwd, env: {} as NodeJS.ProcessEnv, home: tempDir() };
}

const emptyLocation = () => ({
  cwd: tempDir(),
  env: {} as NodeJS.ProcessEnv,
  home: tempDir(),
});

describe("findConfigFile", () => {
  it("returns null when there is no config anywhere", () => {
    expect(findConfigFile(emptyLocation())).toBeNull();
  });

  it("finds one in the working directory", () => {
    const location = withConfig({});
    expect(findConfigFile(location)).toBe(join(location.cwd, CONFIG_FILENAME));
  });

  it("falls back to the journal directory", () => {
    const home = tempDir();
    mkdirSync(join(home, ".mcp-blackbox"), { recursive: true });
    const path = join(home, ".mcp-blackbox", CONFIG_FILENAME);
    writeFileSync(path, "{}");
    expect(findConfigFile({ cwd: tempDir(), env: {} as NodeJS.ProcessEnv, home })).toBe(path);
  });

  it("prefers the working directory over the journal directory", () => {
    const location = withConfig({});
    mkdirSync(join(location.home, ".mcp-blackbox"), { recursive: true });
    writeFileSync(join(location.home, ".mcp-blackbox", CONFIG_FILENAME), "{}");
    expect(findConfigFile(location)).toBe(join(location.cwd, CONFIG_FILENAME));
  });

  it("looks under MCP_BLACKBOX_DIR when set", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "{}");
    const found = findConfigFile({
      cwd: tempDir(),
      env: { MCP_BLACKBOX_DIR: dir } as NodeJS.ProcessEnv,
      home: tempDir(),
    });
    expect(found).toBe(join(dir, CONFIG_FILENAME));
  });
});

describe("loadConfig", () => {
  it("uses the defaults when no file exists", () => {
    const loaded = loadConfig(emptyLocation());
    expect(loaded.path).toBeNull();
    expect(loaded.problems).toEqual([]);
    expect(loaded.redaction.maxStringLength).toBe(DEFAULT_MAX_STRING_LENGTH);
  });

  it("overrides the maximum string length", () => {
    const loaded = loadConfig(withConfig({ redaction: { maxStringLength: 10 } }));
    expect(loaded.redaction.maxStringLength).toBe(10);
    expect(redactString("12345678901", loaded.redaction)).toContain("<tronqué:sha256:");
  });

  it("adds custom sensitive keys without losing the built-ins", () => {
    const loaded = loadConfig(withConfig({ redaction: { keys: ["internal_ref"] } }));
    const result = redact(
      { internal_ref: "abc", password: "x", user: "jo" },
      loaded.redaction,
    ) as Record<string, unknown>;
    expect(result["internal_ref"]).toBe(REDACTED);
    expect(result["password"]).toBe(REDACTED);
    expect(result["user"]).toBe("jo");
  });

  it("adds custom value patterns", () => {
    const loaded = loadConfig(
      withConfig({ redaction: { patterns: [{ name: "employee", regex: "EMP-\\d{6}" }] } }),
    );
    expect(redactString("ticket for EMP-123456 here", loaded.redaction)).toBe(
      "ticket for [redacted:employee] here",
    );
  });

  it("applies a custom pattern to every occurrence", () => {
    const loaded = loadConfig(
      withConfig({ redaction: { patterns: [{ name: "x", regex: "AB\\d" }] } }),
    );
    expect(redactString("AB1 and AB2", loaded.redaction)).toBe("[redacted:x] and [redacted:x]");
  });

  it("can switch a built-in pattern off", () => {
    const loaded = loadConfig(withConfig({ redaction: { disablePatterns: ["email"] } }));
    expect(redactString("jo@example.com", loaded.redaction)).toBe("jo@example.com");
    // Others stay on.
    expect(redactString("sk-abcdefghijklmnopqrstuvwxyz0123", loaded.redaction)).toBe(
      "[redacted:api-key]",
    );
  });

  describe("invalid input never throws", () => {
    it("falls back to defaults on malformed JSON", () => {
      const loaded = loadConfig(withConfig("{ not json"));
      expect(loaded.redaction.maxStringLength).toBe(DEFAULT_MAX_STRING_LENGTH);
      expect(loaded.problems.join(" ")).toContain("not readable as JSON");
    });

    it("falls back to defaults when the file is not an object", () => {
      const loaded = loadConfig(withConfig("[1,2,3]"));
      expect(loaded.problems.join(" ")).toContain("expected a JSON object");
    });

    it("ignores an invalid regex and keeps the rest working", () => {
      const loaded = loadConfig(
        withConfig({ redaction: { patterns: [{ name: "bad", regex: "([" }] } }),
      );
      expect(loaded.problems.join(" ")).toContain("not a valid regex");
      expect(redactString("jo@example.com", loaded.redaction)).toBe("[redacted:email]");
    });

    it.each([
      [{ maxStringLength: -1 }, "positive integer"],
      [{ maxStringLength: "big" }, "positive integer"],
      [{ keys: "token" }, "must be an array"],
      [{ patterns: {} }, "must be an array"],
      [{ disablePatterns: "email" }, "must be an array"],
    ])("reports %o without throwing", (redaction, expected) => {
      const loaded = loadConfig(withConfig({ redaction }));
      expect(loaded.problems.join(" ")).toContain(expected);
      expect(loaded.redaction.maxStringLength).toBeGreaterThan(0);
    });

    it("ignores a pattern entry missing its regex", () => {
      const loaded = loadConfig(withConfig({ redaction: { patterns: [{ name: "x" }] } }));
      expect(loaded.problems.join(" ")).toContain("need a name and a regex");
    });

    it("accepts a file with no redaction section", () => {
      const loaded = loadConfig(withConfig({ somethingElse: true }));
      expect(loaded.problems).toEqual([]);
      expect(loaded.redaction.maxStringLength).toBe(DEFAULT_MAX_STRING_LENGTH);
    });
  });
});
