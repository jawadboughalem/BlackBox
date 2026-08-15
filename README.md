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

Both take an optional path — a journal file, or a directory of them — and
accept `--json`. With no path they read every journal in the recording
directory. `verify` exits 1 if any chain is broken.

## A journal entry

Every completed `tools/call` appends one JSON object to a journal in
`~/.mcp-blackbox/`. Set `MCP_BLACKBOX_DIR` to record elsewhere.

Each proxy session writes its own file, named for the moment it started and the
process that wrote it:

```
~/.mcp-blackbox/
  index.jsonl
  journal-20260815T174508Z-11240.jsonl
  journal-20260815T174508Z-11242.jsonl
```

MCP clients routinely run several servers at once. If those sessions shared one
file they would each read its tail at startup, claim the same sequence numbers
and interleave their writes, producing a chain that fails verification with
nobody having tampered with anything. A file per session removes the shared
state rather than guarding it, so no locking is needed to be correct. Each file
carries its own chain from the genesis hash, and `verify` and `summary` read
them all. A session that records nothing leaves no file behind.

`index.jsonl` holds one line per journal, chained the same way entries are, and
written when a session closes. Without it, deleting a whole session would be
invisible: the journals that remain are independent chains, so they would still
verify and `verify` would report the record intact. That is the worst thing a
recorder can do — not "the evidence is missing" but "the tool certifies there
is nothing to see". With the index, an absent session is an error.

```json
{
  "seq": 7,
  "file": "journal-20260815T142231Z-48219.jsonl",
  "opened_at": "2026-08-15T14:22:31.004Z",
  "closed_at": "2026-08-15T14:41:02.887Z",
  "entries": 314,
  "last_entry_hash": "sha256:77ca...",
  "prev_hash": "sha256:...",
  "hash": "sha256:..."
}
```

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
| `seq` | Position **within this file**, starting at 1 — not global; each journal numbers its own entries |
| `ts` | ISO 8601 timestamp of completion, UTC |
| `server` | Name the server gave in its `initialize` response, else the command used to launch it |
| `tool` | Value of `params.name` in the request |
| `args_redacted` | Arguments after redaction — see below |
| `args_hash` | Hash of the arguments **before** redaction |
| `outcome` | `ok` or `error` |
| `error_kind` | `protocol` for a JSON-RPC error — the call never ran; `tool` for a result carrying `isError` — it ran and refused; `null` when `outcome` is `ok` |
| `error_message` | Message from the error, else `null` |
| `duration_ms` | Time between the request and its matching response |
| `result_hash` | Hash of the response payload — `result`, or `error` when the call failed |
| `prev_hash` | `hash` of the previous entry; all zeroes for the first |
| `hash` | Hash of this entry, excluding this field |

Entries are appended and flushed one at a time, so a crash loses at most the
call in flight. Journals are created `0600` inside a `0700` directory, since
they hold tool arguments and file paths that redaction is not guaranteed to
have recognised as sensitive.

Recording never interferes with relaying. If the journal cannot be opened or
written — read-only disk, missing permissions, a corrupt tail that would make
the chain unverifiable — recording switches off and the proxy keeps serving
traffic. The server your client depends on does not fail because a log file
could not be written. When a call cannot be recorded the reason goes to stderr:
`verify` cannot detect a call that was never written, so a silent gap would be
undetectable afterwards.

Journals accumulate; nothing prunes them, and they cannot be removed quietly:
every one is listed in the index, so deleting a file makes `verify` report it
as `MISSING`. Archive them elsewhere rather than deleting them, or accept that
`verify` will flag the gap from then on. `verify` and `summary` read files in
chunks rather than whole, so a journal larger than memory is still usable.

## Limits

**Deletion is made evident, not impossible.** Nothing that runs on the same
machine as the attacker can prevent a file being removed. The index turns the
removal of any past session into a `MISSING` error, and removing its index line
as well breaks the index chain. What no local design can catch is truncation:
dropping the most recent sessions, or the last entries of a journal, leaves a
shorter chain that still verifies. Only an anchor kept outside the machine —
a copy of the index head elsewhere, a remote log — closes that, and this tool
deliberately keeps nothing outside the machine. Deleting the directory outright
is likewise visible only to someone who knows it should exist.

**The journal records what was done, not what was allowed.** When a client asks
a human to approve a tool call, the click happens inside the client, before the
message reaches the proxy. What arrives here is an approved call and a refused
one that was never sent — indistinguishable, because the second never appears.
Latency could be used to guess, and deliberately is not: a record that infers
consent is worse than one that admits it cannot see it.

**Redaction is syntactic.** It matches names, shapes and lengths, so it misses
a secret that reads like prose and may redact a value that merely resembles
one.

## What this does not do

- No cloud. There is no service to sign up for and no account.
- No telemetry, no analytics, no crash reporting, no update check.
- No network access of any kind. The tool opens no sockets.
- No data leaves the machine. Journals are files in your home directory,
  created private to your user account.
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
malformed field falls back to the default for that setting, and the reason is
reported on stderr — a config that silently redacted less than asked for would
be worse than one that failed loudly.

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

**The index** uses exactly the same rules: `index.jsonl` is a chain of its own,
each line hashed without its `hash` field and carrying the previous line's, so
one implementation verifies both. Checking a whole directory means three
things: each journal's chain, the index's chain, and their agreement — every
indexed file present, with the `entries` count and `last_entry_hash` the index
recorded.

**Chain.** For entry *n*, in file order:

- `seq` equals *n*, counting from 1 within that file and ignoring blank lines —
  numbering is per file, so a third-party verifier must not expect it to
  continue across journals;
- `prev_hash` equals entry *n-1*'s `hash`, or `sha256:` followed by 64 zeroes
  for the first entry of that file — each journal is an independent chain;
- `hash` equals the entry hash computed above.

The same rule produces `args_hash` and `result_hash`, applied to the arguments
and the response payload respectively, with `null` standing in for an absent
value.

**Reference verifier.** This checks all three things, uses only the Python
standard library, and shares no code with this project:

```python
import hashlib, json, os, sys

GENESIS = "sha256:" + "0" * 64

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)

def line_hash(record):
    body = {k: v for k, v in record.items() if k != "hash"}
    return "sha256:" + hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()

def read(path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)

def verify_chain(path, label):
    prev, count = GENESIS, 0
    for record in read(path):
        count += 1
        if record["seq"] != count:
            sys.exit(f"BROKEN {label} at {count}: seq is {record['seq']}")
        if record["prev_hash"] != prev:
            sys.exit(f"BROKEN {label} at {count}: prev_hash mismatch")
        if line_hash(record) != record["hash"]:
            sys.exit(f"BROKEN {label} at {count}: hash mismatch")
        prev = record["hash"]
    return count, prev

directory = sys.argv[1]
is_journal = lambda n: n == "journal.jsonl" or (n.startswith("journal-") and n.endswith(".jsonl"))

# 1. Each session's own chain.
facts = {}
for name in sorted(filter(is_journal, os.listdir(directory))):
    facts[name] = verify_chain(os.path.join(directory, name), name)

# 2. The index's chain, and 3. its agreement with what is on disk.
index = os.path.join(directory, "index.jsonl")
sessions, indexed = 0, set()
if os.path.exists(index):
    prev = GENESIS
    for record in read(index):
        sessions += 1
        if record["seq"] != sessions:
            sys.exit(f"BROKEN index at {sessions}: seq is {record['seq']}")
        if record["prev_hash"] != prev:
            sys.exit(f"BROKEN index at {sessions}: prev_hash mismatch")
        if line_hash(record) != record["hash"]:
            sys.exit(f"BROKEN index at {sessions}: hash mismatch")
        prev = record["hash"]
        indexed.add(record["file"])
        if record["file"] not in facts:
            sys.exit(f"MISSING: {record['file']} is recorded in the index but absent")
        count, last = facts[record["file"]]
        if count != record["entries"] or last != record["last_entry_hash"]:
            sys.exit(f"MISMATCH: {record['file']} disagrees with the index")

for name in facts:
    if name not in indexed:
        print(f"note: {name} is not recorded in the index")

print(f"OK - {sum(c for c, _ in facts.values())} entries across {sessions} sessions")
```

```
$ python3 verify.py ~/.mcp-blackbox
OK - 5 entries across 3 sessions
```

One caveat if you port this: Python sorts keys by Unicode code point and
JavaScript by UTF-16 code unit. The two agree for every field name in the
schema, and differ only for keys containing characters outside the Basic
Multilingual Plane.

**What the chain proves.** A journal has not been edited in place, no entry has
been removed, reordered or inserted, a truncated write is visible, and — with
the index — no recorded session has been deleted. What it does not prove is set
out under [Limits](#limits) above: it is evidence of tampering, not a defence
against it.

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
