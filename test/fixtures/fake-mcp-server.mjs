// Minimal stand-in for an MCP server: line-delimited JSON-RPC 2.0 over stdio.
// Responds to `initialize` and `tools/call`, and supports a few switches the
// tests use to drive the proxy into its edge cases.
//
//   --emit-garbage   write a non-JSON line before serving requests
//   --exit-code <n>  exit with <n> once stdin closes
//   --log <text>     write <text> to stderr at startup
//   --ignore-signals ignore SIGINT/SIGTERM so the kill path is exercised
//   --no-trailing-newline  send the last response without a final newline

import { argv, exit, stdin, stdout, stderr } from "node:process";

const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

const exitCode = Number(value("--exit-code", "0"));
const omitFinalNewline = flag("--no-trailing-newline");

if (flag("--ignore-signals")) {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
}

const log = value("--log", null);
if (log) stderr.write(`${log}\n`);

if (flag("--emit-garbage")) {
  // Not JSON, and deliberately ill-formed: the proxy must not touch it.
  stdout.write('this is not json {"half":\n');
}

let pending = "";
let lastLine = null;

// Responses go out as soon as they are produced, like a real server. The one
// exception is --no-trailing-newline, which has to hold the last line back to
// know that it is the last one.
const send = (message) => {
  const line = JSON.stringify(message);
  if (!omitFinalNewline) {
    stdout.write(`${line}\n`);
    return;
  }
  if (lastLine !== null) stdout.write(`${lastLine}\n`);
  lastLine = line;
};

const handle = (request) => {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-server", version: "0.0.1" },
      },
    };
  }

  if (request.method === "tools/call") {
    const name = request.params?.name ?? "unknown";

    // A protocol-level failure: the call itself could not be dispatched.
    if (name === "explode") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "Unknown tool: explode" },
      };
    }

    // A tool-level failure: the call succeeded, the tool reported an error.
    if (name === "tool-error") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { isError: true, content: [{ type: "text", text: "disk on fire" }] },
      };
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: `called ${name}` }] },
    };
  }

  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: `Method not found: ${request.method}` },
  };
};

stdin.setEncoding("utf8");

stdin.on("data", (chunk) => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.trim() === "") continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      // Echo unparseable input straight back so the test can assert the proxy
      // delivered the exact bytes it was handed.
      send({ jsonrpc: "2.0", error: { code: -32700, message: line } });
      continue;
    }

    if (request.id === undefined) continue; // notification: no reply
    send(handle(request));
  }
});

stdin.on("end", () => {
  if (omitFinalNewline && lastLine !== null) stdout.write(lastLine);
  stdout.end(() => exit(exitCode));
});
