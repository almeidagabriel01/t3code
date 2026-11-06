import { assert, it } from "@effect/vitest";
import type { Assistant } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AssistantService from "../../../assistants/AssistantService.ts";
import { run } from "./handlers.ts";

const assistant = (id: string, extra: Partial<Assistant>) =>
  ({
    id,
    handle: id,
    name: id.toUpperCase(),
    projectId: "p1",
    threadId: `assistant:${id}:1`,
    toolAccess: "full",
    role: "",
    reportsTo: null,
    mcpServers: [],
    archivedAt: null,
    ...extra,
  }) as unknown as Assistant;

const layer = Layer.mock(AssistantService.AssistantService)({
  list: Effect.succeed([
    assistant("ceo", {
      role: "CEO",
      askBeforeActing: true,
      icon: "scout",
      mcpServers: [
        {
          name: "docs",
          transport: "http",
          enabled: true,
          args: [],
          env: [],
          headers: [{ key: "A", hasValue: true }],
        },
      ],
    }),
    assistant("eng", { role: "Engineer", reportsTo: "ceo" as never }),
  ]),
  teams: Effect.succeed([
    {
      id: "t1",
      name: "Core",
      memberIds: ["ceo", "eng"],
      leaderId: "ceo",
      leaderTitle: "CEO",
    },
  ] as never),
});

it.effect("list and read give each assistant its role, leader and reports by handle", () =>
  Effect.gen(function* () {
    const listed = yield* run({ action: "list" });
    assert.deepInclude((listed.assistants as Array<object>)[0], {
      handle: "ceo",
      role: "CEO",
      askBeforeActing: true,
      icon: "scout",
      connectors: [{ name: "docs", transport: "http", enabled: true }],
      reportsTo: null,
      reports: ["eng"],
      teams: [{ name: "Core", members: ["ceo", "eng"], leader: "ceo", leaderTitle: "CEO" }],
    });
    const read = yield* run({ action: "read", handle: "@ENG" });
    assert.notInclude(JSON.stringify(listed), "hasValue");
    assert.deepInclude(read, { role: "Engineer", reportsTo: "ceo", reports: [] });
    assert.strictEqual((yield* Effect.flip(run({ action: "read" }))).code, "invalid_request");
    assert.strictEqual(
      (yield* Effect.flip(run({ action: "read", handle: "nobody" }))).code,
      "invalid_request",
    );
  }).pipe(Effect.provide(layer)),
);
