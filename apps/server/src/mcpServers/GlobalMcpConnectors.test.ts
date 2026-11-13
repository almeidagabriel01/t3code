import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsError, type T3McpServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import {
  globalMcpConnectors,
  t3ServerAllowed,
  type ThreadMcpContext,
} from "./GlobalMcpConnectors.ts";

const integration = (availability: "assistants" | "all"): T3McpServer => ({
  enabled: true,
  transport: "http",
  url: "https://mcp.example.test/mcp",
  headers: {},
  integration: { catalogId: "google-calendar", auth: "oauth", availability },
});

const servers = {
  local: {
    enabled: true,
    transport: "stdio" as const,
    command: "example",
    args: ["serve"],
    env: { TOKEN: "value" },
  },
  remote: {
    enabled: true,
    transport: "http" as const,
    url: "https://mcp.example.test/mcp",
    headers: { Authorization: "Bearer value" },
  },
  off: { enabled: false, transport: "stdio" as const, command: "never", args: [], env: {} },
  "google-calendar": integration("assistants"),
  linear: integration("all"),
} satisfies Record<string, T3McpServer>;
const settings = {
  getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, mcpServers: servers }),
};

const session = {
  endpoint: "http://127.0.0.1:4100/mcp",
  authorizationHeader: "Bearer thread-token",
};
const all: ThreadMcpContext["assistant"] = { integrations: { mode: "all" } };
const calendarOnly: ThreadMcpContext["assistant"] = {
  integrations: { mode: "selected", names: ["google-calendar", "gone"] },
};

it.each([
  ["a hand-made server reaches other threads", "remote", undefined, true],
  ["an all-threads integration reaches other threads", "linear", undefined, true],
  ["an assistants-only integration skips other threads", "google-calendar", undefined, false],
  ["a disabled server reaches nobody", "off", all, false],
  ["an assistant on all gets assistants-only integrations", "google-calendar", all, true],
  ["an assistant gets what it selected", "google-calendar", calendarOnly, true],
  ["an assistant misses an integration it did not select", "linear", calendarOnly, false],
  ["the selection applies to hand-made servers too", "remote", calendarOnly, false],
] as const)("%s", (_, name, assistant, allowed) => {
  expect(t3ServerAllowed(name, servers[name], assistant)).toBe(allowed);
});

it.effect(
  "other threads get hand-made servers as they are and integrations through the proxy",
  () =>
    Effect.gen(function* () {
      expect(yield* globalMcpConnectors(settings, { assistant: undefined, session })).toEqual([
        {
          name: "local_t3",
          transport: "stdio",
          command: "example",
          args: ["serve"],
          headers: {},
          env: { TOKEN: "value" },
        },
        {
          name: "remote_t3",
          transport: "http",
          url: "https://mcp.example.test/mcp",
          args: [],
          headers: { Authorization: "Bearer value" },
          env: {},
        },
        {
          name: "linear_t3",
          transport: "http",
          url: "http://127.0.0.1:4100/mcp/integrations/linear",
          args: [],
          headers: { Authorization: "Bearer thread-token" },
          env: {},
          proxy: { preApproved: false },
        },
      ]);
    }),
);

it.effect("an assistant gets only its selection, pre-approved, and a disconnected name drops", () =>
  Effect.gen(function* () {
    expect(yield* globalMcpConnectors(settings, { assistant: calendarOnly, session })).toEqual([
      {
        name: "google-calendar_t3",
        transport: "http",
        url: "http://127.0.0.1:4100/mcp/integrations/google-calendar",
        args: [],
        headers: { Authorization: "Bearer thread-token" },
        env: {},
        proxy: { preApproved: true },
      },
    ]);
    // Without a T3 session there is no token to reach the proxy with.
    expect(
      yield* globalMcpConnectors(settings, { assistant: calendarOnly, session: undefined }),
    ).toEqual([]);
  }),
);

it.effect("unreadable settings add no connectors", () =>
  Effect.gen(function* () {
    const failing = {
      getSettings: Effect.fail(
        new ServerSettingsError({ settingsPath: "/missing/settings.json", operation: "read-file" }),
      ),
    };
    expect(yield* globalMcpConnectors(failing, { assistant: undefined, session })).toEqual([]);
  }),
);
