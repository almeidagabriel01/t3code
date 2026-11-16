/** The MCP servers and skills page's fixed labels; Settings search reads these same strings. */
export const MCP_SERVERS_COPY = {
  title: "MCP servers",
  footer: "Every provider session on this environment gets the enabled servers.",
  notSupported: "OpenCode, Pi, and Muse do not support MCP servers added here.",
  secretsDescription:
    "Values are stored on the server and shown masked. Leave a saved value as it is to keep it.",
  serverName: "Server name",
  serverNameLocked: "A name cannot change once saved, because saved values belong to it.",
  type: { title: "Type", description: "Where the server runs." },
  stdio: "Command (stdio)",
  http: "HTTP server (URL)",
  command: { title: "Command", description: "The program that starts the MCP server." },
  args: { title: "Arguments", description: "One per line." },
  url: {
    title: "URL",
    description: "The MCP endpoint over HTTPS. Put tokens in headers, not in the URL.",
  },
  environmentVariables: "Environment variables",
  headers: "Headers",
} as const;

export const GLOBAL_SKILLS_COPY = {
  title: "T3 skills",
  footer:
    "Put a skill folder with a SKILL.md in this environment's skills folder, then rescan. Call it in a message with $t3:<folder-name>.",
} as const;

export const AGENT_TOOLS_PAGE_LABELS: readonly string[] = [
  ...Object.values(MCP_SERVERS_COPY).flatMap((copy) =>
    typeof copy === "string" ? [copy] : Object.values(copy),
  ),
  ...Object.values(GLOBAL_SKILLS_COPY),
];
