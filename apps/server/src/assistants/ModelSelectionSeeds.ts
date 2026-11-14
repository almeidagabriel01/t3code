import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type Project,
  type ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { encodeModelSelectionJson } from "./AssistantTeams.ts";

// Fork-only starting defaults: the t3code projects and the "Beyond · Dev" group run on the Beyond
// instance. Each target gets one marker, so a default the user clears or changes never comes back.
export const BEYOND_INSTANCE_ID = ProviderInstanceId.make("claudeAgent_claude_beyond");
const SEEDED_REPOSITORY = "t3code";
const SEEDED_TEAM = "Beyond · Dev";

const projectSeedId = (projectId: ProjectId) => `project-default:${projectId}`;

type SeedProject = Pick<Project, "id" | "repositoryIdentity"> &
  Partial<Pick<Project, "defaultModelSelection" | "workspaceRoot">>;

/** Applies every seed not applied yet; a missing or disabled Beyond instance leaves all unmarked. */
export const applyModelSelectionSeeds = Effect.fn("ModelSelectionSeeds.apply")(function* (
  projects: ReadonlyArray<SeedProject>,
) {
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const settings = yield* serverSettings.getSettings;
  const instance = Object.hasOwn(settings.providerInstances, BEYOND_INSTANCE_ID)
    ? settings.providerInstances[BEYOND_INSTANCE_ID]
    : undefined;
  if (instance === undefined) return;
  // The registry may not have probed the instance yet at start; the driver's default stands in.
  const providers = Option.isSome(providerRegistry)
    ? yield* providerRegistry.value.getProviders
    : [];
  const model =
    providers
      .find((provider) => provider.instanceId === BEYOND_INSTANCE_ID)
      ?.models.find((entry) => entry.isDefault && !entry.isCustom)?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[instance.driver];
  if (model === undefined) return;
  const selection: ModelSelection = { instanceId: BEYOND_INSTANCE_ID, model };

  const applied = new Set(
    (yield* sql<{ readonly seed_id: string }>`SELECT seed_id FROM model_selection_seeds`).map(
      (row) => row.seed_id,
    ),
  );
  const mark = (seedId: string) =>
    DateTime.now.pipe(
      Effect.flatMap(
        (now) => sql`
          INSERT OR IGNORE INTO model_selection_seeds (seed_id, applied_at)
          VALUES (${seedId}, ${DateTime.formatIso(now)})`,
      ),
    );

  for (const project of projects) {
    const seedId = projectSeedId(project.id);
    if (project.repositoryIdentity?.name !== SEEDED_REPOSITORY || applied.has(seedId)) continue;
    const current = yield* serverSettings.getSettings;
    if (!resolveProjectProviderInstanceEnabled(current, project.id, BEYOND_INSTANCE_ID)) continue;
    const stored = current.projectSettingsOverrides[project.id];
    // Any default counts, even one the resolver skips because its instance is off.
    const hasDefault =
      stored?.defaultModelSelection != null ||
      resolveProjectSettings(current, project.id, project).sources.defaultModelSelection !==
        "environment";
    if (!hasDefault) {
      // The patch replaces the project's whole override set, so the rest is sent back as is.
      yield* serverSettings.updateSettings({
        projectSettingsOverrides: {
          [project.id]: { ...stored, defaultModelSelection: selection },
        },
      });
    }
    yield* mark(seedId);
  }

  if (!resolveProjectProviderInstanceEnabled(settings, null, BEYOND_INSTANCE_ID)) return;
  const teams = yield* sql<{ readonly team_id: string }>`
    SELECT team_id FROM assistant_teams WHERE name = ${SEEDED_TEAM}`;
  for (const team of teams) {
    const seedId = `team-default:${team.team_id}`;
    if (applied.has(seedId)) continue;
    yield* sql`
      UPDATE assistant_teams SET default_model_selection = ${encodeModelSelectionJson(selection)}
      WHERE team_id = ${team.team_id} AND default_model_selection IS NULL`;
    yield* mark(seedId);
  }
});

const listProjects = Effect.gen(function* () {
  const service = yield* ProjectService.ProjectService;
  const projects: Array<Project> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: Effect.Success<ReturnType<typeof service.listPage>> = yield* service.listPage({
      cursor,
      limit: 50,
    });
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

const seedProject = Effect.fn("ModelSelectionSeeds.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  const marked = yield* sql`
    SELECT 1 FROM model_selection_seeds WHERE seed_id = ${projectSeedId(projectId)}`;
  if (marked.length > 0) return;
  const project = yield* (yield* ProjectService.ProjectService).getById(projectId);
  if (Option.isNone(project)) return;
  // The resolver, not the enrichment cache: a finished clone refreshes it before its meta update.
  const repositoryIdentity =
    yield* (yield* RepositoryIdentityResolver.RepositoryIdentityResolver).resolve(
      project.value.workspaceRoot,
    );
  yield* applyModelSelectionSeeds([{ ...project.value, repositoryIdentity }]);
});

/**
 * Seeds every listed project off the startup path (resolving repositories runs git), then each
 * project created or updated later. Events after the sequence read first cover the listing race.
 */
export const start = Effect.gen(function* () {
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const afterSequence = yield* events.latestApplicationSequence;
  yield* listProjects.pipe(
    Effect.flatMap(applyModelSelectionSeeds),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to apply model selection seeds.", cause),
    ),
  );
  yield* events
    .streamApplicationEvents({ afterSequence })
    .pipe(
      Stream.runForEach((event) =>
        "aggregateKind" in event &&
        event.aggregateKind === "project" &&
        (event.type === "project.created" || event.type === "project.meta-updated")
          ? seedProject(event.aggregateId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to apply a project's model selection seed.", cause),
              ),
            )
          : Effect.void,
      ),
    );
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("Model selection seeding stopped.", cause)),
  Effect.forkScoped,
  Effect.asVoid,
);
