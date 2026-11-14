import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AssistantId,
  AssistantTeamId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectModelSelection from "./ProjectModelSelectionService.ts";
import * as ProjectStore from "./ProjectStore.ts";

const pick = (instanceId: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: `${instanceId}-model`,
});

const withDefault = ProjectId.make("with-default");
const bare = ProjectId.make("bare");
const disabled = ProjectId.make("disabled");
const ana = AssistantId.make("ana");
const bob = AssistantId.make("bob");
const dev = AssistantTeamId.make("dev");
const offTeam = AssistantTeamId.make("off-team");

const enabled = (instanceId: string) => [instanceId, { driver: "codex", enabled: true }] as const;

const layer = ProjectModelSelection.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ServerSettings.layerTest({
        providerInstances: Object.fromEntries([
          enabled("exception"),
          enabled("project"),
          enabled("team"),
          enabled("assistant"),
          enabled("global"),
          ["off", { driver: "codex", enabled: false }],
        ]),
        defaultModelSelection: pick("global"),
        projectSettingsOverrides: {
          [withDefault]: {
            defaultModelSelection: pick("project"),
            assistantModelSelections: { [ana]: pick("exception") },
          },
          [disabled]: {
            defaultModelSelection: pick("off"),
            assistantModelSelections: { [ana]: pick("off") },
          },
        },
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
      SqlitePersistence.layerMemory,
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const json = (instanceId: string) => JSON.stringify(pick(instanceId));
  yield* sql`
    INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, default_model_selection, created_at, updated_at)
    VALUES (${ana}, 'ana', 'Ana', 'p', 'full', ${json("assistant")}, 't', 't'),
           (${bob}, 'bob', 'Bob', 'p', 'full', NULL, 't', 't')`;
  yield* sql`
    INSERT INTO assistant_teams (team_id, name, member_ids_json, default_model_selection, created_at, updated_at)
    VALUES (${dev}, 'Dev', '[]', ${json("team")}, 't', 't'),
           (${offTeam}, 'Off', '[]', ${json("off")}, 't', 't')`;
});

it.effect("each layer wins over the ones below it, and a disabled instance skips its layer", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* ProjectModelSelection.ProjectModelSelectionService;
    const cases = [
      [{ projectId: withDefault, assistantId: ana, teamId: dev }, "assistantProject", "exception"],
      [{ projectId: withDefault, assistantId: bob, teamId: dev }, "project", "project"],
      // The global default is set, so a project without its own must not read it as "project".
      [{ projectId: bare, assistantId: ana, teamId: dev }, "team", "team"],
      [{ projectId: bare, assistantId: ana }, "assistant", "assistant"],
      [{ projectId: bare, assistantId: bob }, "global", "global"],
      [{ projectId: disabled, assistantId: ana, teamId: offTeam }, "assistant", "assistant"],
      [{ projectId: withDefault, assistantId: ana, explicit: pick("team") }, "message", "team"],
      [{ projectId: bare, explicit: pick("off") }, "global", "global"],
    ] as const;
    for (const [input, layerName, instanceId] of cases) {
      const resolved = yield* service.resolveForNewThread(input);
      assert.deepStrictEqual(
        [resolved.layer, resolved.selection.instanceId],
        [layerName, instanceId],
        JSON.stringify(input),
      );
    }
  }).pipe(Effect.provide(layer)),
);
