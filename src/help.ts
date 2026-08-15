export const HELP_TEXT = `mcp-blackbox — record and inspect MCP server sessions.

Usage:
  mcp-blackbox -- <server-command> [args...]   Run a server through the proxy
  mcp-blackbox verify [path] [--json]          Check the journal's hash chain
  mcp-blackbox summary [path] [--json]         Summarize recorded calls
  mcp-blackbox --help                          Show this help
  mcp-blackbox --version                       Show the version

Arguments:
  <server-command>  The MCP server to launch. Everything after \`--\` is passed
                    through verbatim, flags included.
  [path]            Journal file, or a directory containing journal.jsonl.
                    Defaults to \\$MCP_BLACKBOX_DIR, else ~/.mcp-blackbox.

Options:
  --json            Print the result as JSON instead of text.

Exit codes:
  0  success
  1  broken chain, or the journal could not be read
  2  usage error

Examples:
  mcp-blackbox -- npx -y @modelcontextprotocol/server-filesystem /tmp
  mcp-blackbox verify
  mcp-blackbox summary --json
`;
