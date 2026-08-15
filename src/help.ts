export const HELP_TEXT = `mcp-blackbox — record and inspect MCP server sessions.

Usage:
  mcp-blackbox -- <server-command> [args...]   Run a server through the proxy
  mcp-blackbox verify [path]                   Verify a recorded session
  mcp-blackbox summary [path]                  Summarize a recorded session
  mcp-blackbox --help                          Show this help
  mcp-blackbox --version                       Show the version

Arguments:
  <server-command>  The MCP server to launch. Everything after \`--\` is passed
                    through verbatim, flags included.
  [path]            Session file or directory. Defaults to the current
                    directory.

Examples:
  mcp-blackbox -- npx -y @modelcontextprotocol/server-filesystem /tmp
  mcp-blackbox verify ./session.jsonl
  mcp-blackbox summary
`;
