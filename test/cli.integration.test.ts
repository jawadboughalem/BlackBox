import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Runs the built CLI, dropping the read end of stdout straight away. */
function runWithClosedStdout(args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.destroy();
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

// Exercises the shipped binary, so it needs `npm run build` first. Skipping
// keeps `npm test` usable on its own rather than failing on a missing dist/.
describe.skipIf(!existsSync(CLI))("built CLI", () => {
  it("exits cleanly when the reader closes the pipe early", async () => {
    const { code, stderr } = await runWithClosedStdout(["summary"]);
    expect(stderr).not.toContain("EPIPE");
    expect(stderr).not.toContain("Unhandled");
    expect(code).toBe(0);
  });
});
