import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { globalMcpConnectors } from "./GlobalMcpConnectors.ts";

const settings = {
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    mcpServers: {
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
    },
  }),
};

it.effect("enabled servers become suffixed connectors with secrets resolved", () =>
  Effect.gen(function* () {
    expect(yield* globalMcpConnectors(settings)).toEqual([
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
    ]);
  }),
);

it.effect("unreadable settings add no connectors", () =>
  Effect.gen(function* () {
    const failing = {
      getSettings: Effect.fail(
        new ServerSettingsError({ settingsPath: "/missing/settings.json", operation: "read-file" }),
      ),
    };
    expect(yield* globalMcpConnectors(failing)).toEqual([]);
  }),
);
