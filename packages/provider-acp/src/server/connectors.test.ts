import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ThreadConnector } from "@t3tools/provider-core/server/mcpSession";

import { acpMcpContext } from "./adapter.ts";

const connectors: ReadonlyArray<ThreadConnector> = [
  {
    name: "docs",
    transport: "http",
    url: "https://docs.example.test/mcp",
    args: [],
    headers: { "X-Key": "k" },
    env: {},
  },
  {
    name: "files",
    transport: "stdio",
    command: "npx",
    args: ["srv"],
    headers: {},
    env: { T: "1" },
  },
];
const session = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("assistant:a:1"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("grok"),
  endpoint: "http://127.0.0.1:1/mcp",
  authorizationHeader: "Bearer t",
  browserToolsAvailable: true,
};
const self = { command: "node", entrypoint: "t3.mjs" } as never;
const names = (servers: ReadonlyArray<object>) =>
  servers.map((server) => ("name" in server ? server.name : "acp"));

describe("ACP connectors", () => {
  it("stdio connectors join every list; http ones only where the flavor allows http", () => {
    const stdioOnly = acpMcpContext(session, self, false, connectors);
    assert.deepEqual(names(stdioOnly.servers), ["files", "t3-code"]);
    assert.deepEqual(names(stdioOnly.acpServers), ["files", "t3-code"]);
    assert.deepEqual(stdioOnly.httpServers, []);
    assert.deepEqual(stdioOnly.servers[0], {
      name: "files",
      command: "npx",
      args: ["srv"],
      env: [{ name: "T", value: "1" }],
    });

    const http = acpMcpContext(session, self, true, connectors);
    assert.deepEqual(names(http.httpServers), ["files", "docs", "t3-code"]);
    assert.deepEqual(http.httpServers[1], {
      type: "http",
      name: "docs",
      url: "https://docs.example.test/mcp",
      headers: [{ name: "X-Key", value: "k" }],
    });
  });

  it("an assistant thread without a T3 session still gets its connectors; others get none", () => {
    assert.deepEqual(names(acpMcpContext(undefined, self, true, connectors).servers), ["files"]);
    assert.deepEqual(acpMcpContext(undefined, self, true).servers, []);
  });
});
