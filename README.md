# mcp-blackbox

CLI to proxy, verify and summarize MCP server sessions.

> Work in progress: proxy mode relays a real MCP server transparently and
> records every completed `tools/call`. `verify` and `summary` are still stubs
> that report the input they would act on.

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

## The journal

Every completed `tools/call` is appended to `~/.mcp-blackbox/journal.jsonl`,
one JSON object per line. Set `MCP_BLACKBOX_DIR` to record elsewhere.

```json
{
  "seq": 4,
  "ts": "2026-08-15T17:00:59.807Z",
  "server": "secure-filesystem-server",
  "tool": "write_file",
  "args_redacted": { "path": "/tmp/demo.txt", "content": "hello" },
  "args_hash": "sha256:d5fb7067…",
  "outcome": "ok",
  "error_message": null,
  "duration_ms": 5,
  "result_hash": "sha256:601b78ae…",
  "prev_hash": "sha256:e9f4666e…",
  "hash": "sha256:cefe94a5…"
}
```

`hash` is the SHA-256 of the canonical JSON of the entry — keys sorted,
recursively — without its own `hash` field. Each entry carries the previous
entry's hash, so any edit to a past entry invalidates every entry after it.
The first entry's `prev_hash` is all zeroes. Entries are appended and flushed
one at a time, and a new session continues the existing chain.

Two details worth knowing:

- `args_redacted` blanks values whose key looks like a credential and trims
  long strings, so the journal is safe to read and share. `args_hash` covers
  the untouched arguments, so integrity does not depend on the redacted copy.
- `outcome` is `error` for a JSON-RPC error *and* for a successful response
  whose result carries `isError` — both are calls that failed.

Recording never interferes with relaying. If the journal cannot be opened or
written — read-only disk, missing permissions, a corrupt tail that would make
the chain unverifiable — recording switches off silently and the proxy keeps
serving traffic.

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
