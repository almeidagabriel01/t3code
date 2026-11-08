import * as Schema from "effect/Schema";
import { ServerSettingsPatch } from "./settings.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvKey,
  T3McpServer,
  HeaderName,
  McpServerName,
  McpServerUrl,
  T3_MCP_SERVER_SUPPORT,
  t3McpProviderName,
} from "./mcpServers.ts";

const stdio = {
  enabled: true,
  transport: "stdio",
  command: "tool",
  args: [],
  env: { TOKEN: "example" },
} as const;
const isEnvKey = Schema.is(EnvKey);
const isHeaderName = Schema.is(HeaderName);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeServer = Schema.decodeUnknownSync(T3McpServer);

describe("T3 MCP servers", () => {
  it("validates names, keys, and URL authority", () => {
    const name = Schema.is(McpServerName);
    expect(name("a-9")).toBe(true);
    for (const invalid of ["", "A", "a_b", "a".repeat(41)]) expect(name(invalid)).toBe(false);
    expect(isEnvKey("_TOKEN9")).toBe(true);
    expect(isEnvKey("BAD:KEY")).toBe(false);
    expect(isHeaderName("X-Token")).toBe(true);
    expect(isHeaderName("Bad:Header")).toBe(false);
    const url = Schema.is(McpServerUrl);
    for (const valid of [
      "https://example.test/path",
      "http://localhost:8080/mcp",
      "http://127.4.3.2",
      "http://[::1]/",
    ])
      expect(url(valid), valid).toBe(true);
    for (const invalid of [
      "http://example.test",
      "https://user@example.test",
      "https://@example.test",
      "  https://@example.test",
      "https:\\\\@example.test",
      "https://example.test/?secret=x",
      "https://example.test/#x",
      "https://example.test/?",
      "file:///tmp/x",
    ])
      expect(url(invalid), invalid).toBe(false);
    expect(decodeServer({ ...stdio, enabled: undefined }).enabled).toBe(true);
    expect(() => decodePatch({ mcpServers: { BAD_NAME: stdio } })).toThrow();
    expect(() =>
      decodePatch({ mcpServers: { ok: { ...stdio, env: { "BAD:KEY": "x" } } } }),
    ).toThrow();
  });
  it("names a server for agents with the T3 suffix and lists transports per driver", () => {
    expect(t3McpProviderName("local")).toBe("local_t3");
    expect(T3_MCP_SERVER_SUPPORT.codex).toEqual(["stdio", "http"]);
    expect(T3_MCP_SERVER_SUPPORT.grok).toEqual(["stdio"]);
    expect(T3_MCP_SERVER_SUPPORT.opencode).toBeUndefined();
  });
});
