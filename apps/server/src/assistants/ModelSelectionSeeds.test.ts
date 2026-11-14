import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { applyModelSelectionSeeds, BEYOND_INSTANCE_ID } from "./ModelSelectionSeeds.ts";

const t3code = ProjectId.make("t3code-main");
const preset = ProjectId.make("t3code-preset");
const other = ProjectId.make("other");
const repo = (name: string) => ({
  canonicalKey: `github.com/me/${name}`,
  locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: `git@x:${name}` },
  name,
});
const projects = [
  { id: t3code, repositoryIdentity: repo("t3code") },
  { id: preset, repositoryIdentity: repo("t3code") },
  { id: other, repositoryIdentity: repo("other") },
];
const chosen: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt" };
const beyond: ModelSelection = { instanceId: BEYOND_INSTANCE_ID, model: "claude-opus-5-5" };
const beyondInstance = {
  [BEYOND_INSTANCE_ID]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
};

const layer = (overrides: Partial<ServerSettings>) =>
  Layer.mergeAll(
    ServerSettingsModule.layerTest({
      ...overrides,
      projectSettingsOverrides: { [preset]: { defaultModelSelection: chosen } },
    }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provide(NodeServices.layer));

const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings;
  return {
    projects: Object.fromEntries(
      [t3code, preset, other].map((id) => [
        id,
        settings.projectSettingsOverrides[id]?.defaultModelSelection ?? null,
      ]),
    ),
    teams: (yield* sql<{ readonly name: string; readonly selection: string | null }>`
      SELECT name, default_model_selection AS selection FROM assistant_teams ORDER BY name`).map(
      (row) => [row.name, row.selection === null ? null : JSON.parse(row.selection)],
    ),
    seeds: (yield* sql<{ readonly seed_id: string }>`
      SELECT seed_id FROM model_selection_seeds ORDER BY seed_id`).map((row) => row.seed_id),
  };
});

const addTeams = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO assistant_teams (team_id, name, member_ids_json, default_model_selection, created_at, updated_at)
    VALUES ('beyond-dev', 'Beyond · Dev', '[]', NULL, 't', 't'),
           ('pessoal-dev', 'Pessoal · Dev', '[]', NULL, 't', 't'),
           ('beyond-old', 'Beyond · Dev', '[]', ${JSON.stringify(chosen)}, 't', 't')`;
});

it.effect("seeds t3code projects and the Beyond · Dev team once, never over a choice", () =>
  Effect.gen(function* () {
    yield* addTeams;
    yield* applyModelSelectionSeeds(projects);
    const first = yield* state;
    assert.deepStrictEqual(first, {
      projects: { [t3code]: beyond, [preset]: chosen, [other]: null },
      teams: [
        ["Beyond · Dev", beyond],
        ["Beyond · Dev", chosen],
        ["Pessoal · Dev", null],
      ],
      seeds: [
        "project-default:t3code-main",
        "project-default:t3code-preset",
        "team-default:beyond-dev",
        "team-default:beyond-old",
      ],
    });
    yield* applyModelSelectionSeeds(projects);
    assert.deepStrictEqual(yield* state, first);

    // Cleared by the user: the marker keeps the seed from coming back.
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    yield* settings.updateSettings({ projectSettingsOverrides: { [t3code]: null } });
    yield* sql`UPDATE assistant_teams SET default_model_selection = NULL WHERE team_id = 'beyond-dev'`;
    yield* applyModelSelectionSeeds(projects);
    const cleared = yield* state;
    assert.deepStrictEqual(
      [cleared.projects[t3code], cleared.teams[0]],
      [null, ["Beyond · Dev", null]],
    );
  }).pipe(Effect.provide(layer({ providerInstances: beyondInstance }))),
);

it.effect("does nothing and marks nothing while the Beyond instance is missing or off", () =>
  Effect.gen(function* () {
    yield* addTeams;
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    yield* applyModelSelectionSeeds(projects);
    yield* settings.updateSettings({
      providerInstances: {
        [BEYOND_INSTANCE_ID]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
      },
    });
    yield* applyModelSelectionSeeds(projects);
    const untouched = yield* state;
    assert.deepStrictEqual(untouched.seeds, []);
    assert.deepStrictEqual(untouched.projects[t3code], null);
    assert.deepStrictEqual(untouched.teams[0], ["Beyond · Dev", null]);

    // Once it is on, the next start applies it.
    yield* settings.updateSettings({ providerInstances: beyondInstance });
    yield* applyModelSelectionSeeds(projects);
    assert.deepStrictEqual((yield* state).projects[t3code], beyond);
  }).pipe(Effect.provide(layer({}))),
);
