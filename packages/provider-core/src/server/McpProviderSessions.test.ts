import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

it.effect("loaded-server reports reach the installed sink and are dropped before it", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const claude = ProviderInstanceId.make("claudeAgent");
    const seen: Array<string> = [];
    yield* sessions.reportLoadedServers(claude, [{ name: "early", status: "connected" }]);
    yield* sessions.installLoadedServersSink((instanceId, servers) =>
      Effect.sync(() => {
        for (const server of servers) seen.push(`${instanceId}:${server.name}:${server.status}`);
      }),
    );
    yield* sessions.reportLoadedServers(claude, [{ name: "linear", status: "needs-auth" }]);
    assert.deepEqual(seen, ["claudeAgent:linear:needs-auth"]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);
