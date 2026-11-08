import * as Schema from "effect/Schema";
import { ServerSettingsPatch } from "./settings.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvKey,
  T3McpServer,
  HeaderName,
  McpServerName,
  McpServerUrl,
  resolveT3McpServersForDriver,
} from "./mcpServers.ts";

const stdio = {
  enabled: true,
  transport: "stdio",
  command: "tool",
  args: [],
  env: { TOKEN: "example" },
} as const;
const http = {
  enabled: true,
  transport: "http",
  url: "https://example.test/mcp",
  headers: {},
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

  it("resolves only enabled transports supported by the driver", () => {
    const servers = { local: stdio, remote: http, disabled: { ...stdio, enabled: false } };
    expect(resolveT3McpServersForDriver(servers, "codex")).toEqual([
      {
        providerName: "local_t3",
        transport: "stdio",
        command: "tool",
        args: [],
        env: { TOKEN: "example" },
      },
      {
        providerName: "remote_t3",
        transport: "http",
        url: "https://example.test/mcp",
        headers: {},
      },
    ]);
    expect(resolveT3McpServersForDriver(servers, "grok").map((s) => s.providerName)).toEqual([
      "local_t3",
    ]);
    expect(resolveT3McpServersForDriver(servers, "fx").map((s) => s.providerName)).toEqual([
      "local_t3",
    ]);
    expect(resolveT3McpServersForDriver(servers, "opencode")).toEqual([]);
    expect(resolveT3McpServersForDriver(servers, "unknown")).toEqual([]);
  });
});
