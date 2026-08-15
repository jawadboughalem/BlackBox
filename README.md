# mcp-blackbox

CLI to proxy, verify and summarize MCP server sessions.

> Work in progress: proxy mode is live and relays a real MCP server
> transparently. `verify` and `summary` are still stubs that report the input
> they would act on, and nothing is recorded yet.

## Requirements

Node.js 20 or newer.

## Usage

```
mcp-blackbox -- <server-command> [args...]   Run a server through the proxy
mcp-blackbox verify [path]                   Verify a recorded session
mcp-blackbox summary [path]                  Summarize a recorded session
mcp-blackbox --help                          Show help
mcp-blackbox --version                       Show the version
```

## Proxy mode

Everything after `--` is passed to the server verbatim, flags included:

```bash
mcp-blackbox -- npx -y @modelcontextprotocol/server-filesystem /tmp
```

The server runs as a child process and the proxy relays stdio around it:
parent stdin to the child, the child's stdout back out framed into `\n`
terminated lines, and the child's stderr straight through. The relay is
byte-transparent — a line that is not valid JSON is forwarded exactly as it
arrived — and stdout carries nothing but relayed traffic. The child's exit code
is propagated, and `SIGINT`/`SIGTERM` are forwarded to it before the proxy
exits.

`verify` and `summary` take an optional path and default to the current
directory:

```bash
mcp-blackbox verify ./session.jsonl
mcp-blackbox summary
```

## Development

```bash
npm install
npm run build      # tsup -> dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
npx .              # run the built CLI locally
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Success |
| `2`  | Usage error (unknown command, bad arguments) |

## License

MIT
