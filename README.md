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

`outcome` is `error` for a JSON-RPC error *and* for a successful response whose
result carries `isError` — both are calls that failed.

## Redaction

`args_redacted` is scrubbed before it is written, by three purely syntactic
mechanisms — no inference about what a value means:

1. **Sensitive key names** — a value under `password`, `token`, `secret`,
   `api_key`, `authorization`, `cookie`, `key` and friends is dropped whole and
   becomes `[redacted]`. Names are matched per segment, so `apiKey`,
   `x-api-key` and `API_KEY` all hit, while `monkey` does not.
2. **Value patterns** — `sk-…` keys, JWTs, IBANs, emails and card numbers are
   replaced wherever they appear, keeping the surrounding text:
   `"ping jo@example.com"` becomes `"ping [redacted:email]"`.
3. **Length** — any string over 500 characters is replaced by
   `<tronqué:sha256:…>`, hashing the original so the value stays identifiable
   without being stored.

`args_hash` is computed from the **original** arguments, before any of this, so
the hash still identifies the real call and two different secrets remain
distinguishable.

Card numbers are matched by regex and then confirmed with the Luhn checksum.
Without it every 16-digit identifier — invoice numbers, ids, concatenated
timestamps — would be redacted as a card.

### Configuration

Drop a `.mcp-blackbox.json` next to your project, or in the journal directory:

```json
{
  "redaction": {
    "maxStringLength": 500,
    "keys": ["client_ref"],
    "patterns": [{ "name": "employee", "regex": "EMP-\\d{6}" }],
    "disablePatterns": ["email"]
  }
}
```

`keys` and `patterns` extend the built-ins rather than replacing them, so a
config can never weaken redaction by accident; switching a built-in off has to
be spelled out in `disablePatterns`. An unreadable file, a bad regex or a
malformed field falls back to the default for that setting rather than failing.

Recording never interferes with relaying. If the journal cannot be opened or
written — read-only disk, missing permissions, a corrupt tail that would make
the chain unverifiable — recording switches off silently and the proxy keeps
serving traffic.

## Reading the journal

`verify` recomputes the whole chain and reports the first place it stops
holding. `summary` aggregates the recorded calls. Both take an optional path —
a journal file, or a directory containing one — and default to the journal this
tool records into.

```bash
$ mcp-blackbox verify
OK — 14 entrées, chaîne intacte

$ mcp-blackbox verify            # after someone edited entry 7
ROMPUE à l'entrée 7 (seq 7) — hash recalculé différent : l'entrée a été modifiée
  fichier : /home/you/.mcp-blackbox/journal.jsonl:7
  6 entrées vérifiées avant la rupture
```

An edit, a deletion, a reordering, a duplicated entry or a truncated line all
break the chain, and `verify` exits 1. Re-hashing the edited entry does not
help: the next entry's `prev_hash` still points at the original.

```bash
$ mcp-blackbox summary
Période   2026-08-15T17:17:24.701Z → 2026-08-15T17:19:02.118Z
Appels    14 (3 en échec, 21.4 %)
Durée     médiane 57 ms · p95 59 ms

Par outil
  search          4
  write_file      4
  read_file       3
  tool-error      3  3 en échec

Par serveur
  fake-mcp-server     14  3 en échec
```

Both accept `--json` for machine-readable output. Percentiles use nearest rank,
so every figure reported is a duration that was actually observed. `summary`
still reports what it can from a damaged journal — telling you the chain is
broken is `verify`'s job.

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
