# mcp-blackbox

A local recorder for MCP tool calls. It sits between an MCP client and an MCP
server, relays their traffic untouched, and appends one tamper-evident line per
completed tool call to a file on your machine.

## The problem

An agent runs for twenty minutes and something expensive happens: a file is
overwritten, an API is billed for thousands of calls, a record is deleted. The
transcript shows what the model said it would do, not what it actually invoked.
MCP servers log for their own debugging, in their own formats, when they log at
all. Afterwards nobody can say which tool ran, with which arguments, or when.

## Installation

Requires Node.js 20 or newer. There is nothing to install ahead of time — the
change is one line in the MCP client configuration that already launches your
server.

Before:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    }
  }
}
```

After:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y", "mcp-blackbox", "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"
      ]
    }
  }
}
```

The server command is unchanged; it moves after `--`. Everything following that
separator is passed through verbatim, flags included. The client sees the same
server it saw before: stdout is relayed byte for byte, the exit code is
propagated, and `SIGINT`/`SIGTERM` reach the server as usual.

Read the result with:

```
mcp-blackbox summary          Aggregate the recorded calls
mcp-blackbox verify           Recompute the hash chain
```

Both take an optional path — a journal file, or a directory containing one —
and accept `--json`. `verify` exits 1 if the chain is broken.

## A journal entry

Every completed `tools/call` appends one JSON object to
`~/.mcp-blackbox/journal.jsonl`. Set `MCP_BLACKBOX_DIR` to record elsewhere.

```json
{
  "seq": 4,
  "ts": "2026-08-15T17:00:59.807Z",
  "server": "secure-filesystem-server",
  "tool": "write_file",
  "args_redacted": { "path": "/data/report.txt", "api_key": "[redacted]" },
  "args_hash": "sha256:d5fb7067aa6dda6382557286121a2d4f7d5ddc11a7e9b0d3d528e75f6edfb5b8",
  "outcome": "ok",
  "error_message": null,
  "duration_ms": 5,
  "result_hash": "sha256:601b78ae274786d6432c1a256d6cdf7c7043c2a827ba0240d8a6b75649e7f50d",
  "prev_hash": "sha256:e9f4666e449b175e647240df2f2ed647092c21da476d3c39def80b31a6912868",
  "hash": "sha256:cefe94a5dbe85913126d384922733b81f9903a07258c7d02cf927e4fe8e408e8"
}
```

| Field | Meaning |
| --- | --- |
| `seq` | Position in the journal, starting at 1 |
| `ts` | ISO 8601 timestamp of completion, UTC |
| `server` | Name the server gave in its `initialize` response, else the command used to launch it |
| `tool` | Value of `params.name` in the request |
| `args_redacted` | Arguments after redaction — see below |
| `args_hash` | Hash of the arguments **before** redaction |
| `outcome` | `ok`, or `error` for a JSON-RPC error or a result carrying `isError` |
| `error_message` | Message from the error, else `null` |
| `duration_ms` | Time between the request and its matching response |
| `result_hash` | Hash of the response payload — `result`, or `error` when the call failed |
| `prev_hash` | `hash` of the previous entry; all zeroes for the first |
| `hash` | Hash of this entry, excluding this field |

Entries are appended and flushed one at a time, so a crash loses at most the
call in flight. A new session continues the existing chain.

Recording never interferes with relaying. If the journal cannot be opened or
written — read-only disk, missing permissions, a corrupt tail that would make
the chain unverifiable — recording switches off and the proxy keeps serving
traffic. The server your client depends on does not fail because a log file
could not be written.

## What this does not do

- No cloud. There is no service to sign up for and no account.
- No telemetry, no analytics, no crash reporting, no update check.
- No network access of any kind. The tool opens no sockets.
- No data leaves the machine. The journal is a file in your home directory, and
  nothing reads it but you.
- No runtime dependencies. The published package is the compiled source and
  nothing else.
- No interpretation of your traffic. Calls are recorded, not judged, scored or
  classified.

## Redaction

`args_redacted` is scrubbed before it is written, by three syntactic
mechanisms. None of them infers what a value means; they match names, shapes
and lengths.

**Key names.** A value under a name whose segments include `password`, `token`,
`secret`, `api_key`, `authorization`, `cookie`, `key`, `credential`, `auth`,
`bearer`, `passphrase` or `pass` is dropped whole and becomes `[redacted]`.
Matching is per segment, so `apiKey`, `x-api-key` and `API_KEY` all match, while
`monkey` and `keyboard` do not.

**Value patterns.** Inside any string, `sk-…` keys, JWTs, IBANs, email addresses
and card numbers are replaced where they appear, keeping the surrounding text:
`"mail me at jo@example.com"` becomes `"mail me at [redacted:email]"`. Card
numbers are matched by shape and then confirmed with the Luhn checksum, because
a bare 13-19 digit run also matches invoice numbers, identifiers and
concatenated timestamps.

**Length.** Any string over 500 characters is replaced by
`<truncated:sha256:…>` over the original. Length is checked before the patterns,
so an over-long value cannot leak through a span no pattern happened to cover.

`args_hash` is computed from the original arguments, before any of this. The
hash therefore identifies the real call, and two different secrets remain
distinguishable even though both are written as `[redacted]`.

Redaction is best effort against a syntactic target. It will not catch a secret
that looks like ordinary prose, and it may redact a value that merely resembles
one. Treat the journal as sensitive.

### Configuration

Place a `.mcp-blackbox.json` in the working directory or in the journal
directory:

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
config cannot weaken redaction by accident; switching a built-in off has to be
stated in `disablePatterns`. An unreadable file, an invalid regex or a
malformed field falls back to the default for that setting.

## The hash chain

Each entry carries the hash of the previous one, so editing any past entry
invalidates every entry after it. Recomputing the edited entry's own hash does
not help: the next entry's `prev_hash` still refers to the original.

The format is specified below so the chain can be checked without this
implementation.

**Canonical form.** An entry is serialised to JSON with:

- object keys sorted ascending by UTF-16 code unit;
- no whitespace between tokens;
- array order preserved;
- properties whose value is `undefined` omitted;
- non-finite numbers written as `null`;
- strings escaped as `JSON.stringify` escapes them, with non-ASCII characters
  left as themselves rather than `\u`-escaped.

This is what `JSON.stringify` produces with keys sorted recursively, and what
Python's `json.dumps(..., sort_keys=True, separators=(",", ":"),
ensure_ascii=False)` produces.

**Entry hash.** Take the entry, remove the `hash` field, serialise the rest in
canonical form, encode as UTF-8, take the SHA-256, and write it lowercase
hexadecimal prefixed with `sha256:`.

**Chain.** For entry *n*, in file order:

- `seq` equals *n*, counting from 1 and ignoring blank lines;
- `prev_hash` equals entry *n-1*'s `hash`, or `sha256:` followed by 64 zeroes
  for the first entry;
- `hash` equals the entry hash computed above.

The same rule produces `args_hash` and `result_hash`, applied to the arguments
and the response payload respectively, with `null` standing in for an absent
value.

**Reference verifier.** This is complete, uses only the Python standard
library, and shares no code with this project:

```python
import hashlib, json, sys

GENESIS = "sha256:" + "0" * 64

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)

def entry_hash(entry):
    body = {k: v for k, v in entry.items() if k != "hash"}
    return "sha256:" + hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()

prev, count = GENESIS, 0
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        count += 1
        if entry["seq"] != count:
            sys.exit(f"BROKEN at entry {count}: seq is {entry['seq']}")
        if entry["prev_hash"] != prev:
            sys.exit(f"BROKEN at entry {count}: prev_hash mismatch")
        if entry_hash(entry) != entry["hash"]:
            sys.exit(f"BROKEN at entry {count}: hash mismatch")
        prev = entry["hash"]
print(f"OK - {count} entries, chain intact")
```

```
$ python3 verify.py ~/.mcp-blackbox/journal.jsonl
OK - 5 entries, chain intact
```

One caveat if you port this: Python sorts keys by Unicode code point and
JavaScript by UTF-16 code unit. The two agree for every field name in the
schema, and differ only for keys containing characters outside the Basic
Multilingual Plane.

**What the chain does and does not prove.** It shows that a journal has not
been edited in place, that no entry has been removed, reordered or inserted,
and that a truncated write is visible. It does not prove the journal is
complete: anyone who can write the file can also delete it and start a new
chain from the genesis hash. The chain is evidence of tampering, not a defence
against it. Preventing deletion is a filesystem or backup concern.

## Development

```bash
npm install
npm run build      # tsup -> dist/
npm test           # vitest, builds first
npm run typecheck  # tsc --noEmit
```

Exit codes: `0` success, `1` broken chain or unreadable journal, `2` usage
error.

## License

MIT
