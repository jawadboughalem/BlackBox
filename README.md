# mcp-blackbox

CLI to proxy, verify and summarize MCP server sessions.

> Early scaffold: argument parsing is complete and tested, but every subcommand
> is still a stub that reports the input it would act on.

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

Everything after `--` is passed to the server verbatim, flags included:

```bash
mcp-blackbox -- npx -y @modelcontextprotocol/server-filesystem /tmp
```

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
