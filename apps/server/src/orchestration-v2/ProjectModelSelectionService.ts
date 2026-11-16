import {
  type AssistantId,
  type AssistantTeamId,
  DEFAULT_MODEL,
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import {
  firstUsableProviderModel,
  isPickedModelUsable,
  type ModelSelectionLayer,
  projectModelLayer,
  resolveModelSelection,
  teamModelLayer,
} from "@t3tools/shared/modelSelectionPrecedence";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type AssistantRow, toAssistant } from "../assistants/AssistantDirectory.ts";
import {
  type AssistantTeamRow,
  decodeModelSelectionJson,
  toAssistantTeam,
} from "../assistants/AssistantTeams.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class ProjectModelSelectionError extends Schema.TaggedError<ProjectModelSelectionError>()(
  "ProjectModelSelectionError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not work out the model for a new thread.";
  }
}

export class ProjectModelSelectionService extends Context.Service<
  ProjectModelSelectionService,
  {
    /**
     * The model new work starts on: explicit, assistant in project, project, team, assistant,
     * then global. A layer whose instance is missing or disabled for the project is skipped, and
     * an explicit model its provider does not list.
     * Never falls back to `fallbackModelSelections`: switching provider is the user's call.
     */
    readonly resolveForNewThread: (input: {
      readonly projectId: ProjectId;
      readonly assistantId?: AssistantId | undefined;
      /** Only for the thread of a group request. */
      readonly teamId?: AssistantTeamId | undefined;
      readonly explicit?: ModelSelection | undefined;
    }) => Effect.Effect<
      { readonly selection: ModelSelection; readonly layer: ModelSelectionLayer },
      ProjectModelSelectionError
    >;
  }
>()("t3/orchestration-v2/ProjectModelSelectionService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);

  const storedDefault = (
    rows: ReadonlyArray<{ readonly default_model_selection: string | null }>,
  ) => decodeModelSelectionJson(rows[0]?.default_model_selection) ?? undefined;

  const resolveForNewThread: ProjectModelSelectionService["Service"]["resolveForNewThread"] =
    Effect.fn("ProjectModelSelectionService.resolveForNewThread")(
      function* ({ projectId, assistantId, teamId, explicit }) {
        const settings = yield* serverSettings.getSettings;
        const project = yield* projects.get(projectId);
        const resolved = resolveProjectSettings(settings, projectId, Option.getOrNull(project));
        const isUsable = (selection: ModelSelection) =>
          resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId);
        const teamRow =
          teamId === undefined
            ? undefined
            : (yield* sql<AssistantTeamRow>`SELECT * FROM assistant_teams WHERE team_id = ${teamId}`)[0];
        const teamValue = teamRow === undefined ? undefined : toAssistantTeam(teamRow);
        const team =
          teamValue === undefined
            ? undefined
            : teamModelLayer(
                teamValue,
                teamValue.memberIds.length === 0
                  ? []
                  : (yield* sql<AssistantRow>`
                      SELECT * FROM assistants WHERE assistant_id IN ${sql.in(teamValue.memberIds)}`).map(
                      toAssistant,
                    ),
                projectId,
              );
        const assistant =
          assistantId === undefined
            ? undefined
            : storedDefault(
                yield* sql<{ readonly default_model_selection: string | null }>`
                  SELECT default_model_selection FROM assistants WHERE assistant_id = ${assistantId}`,
              );
        const providers = Option.isSome(providerRegistry)
          ? yield* providerRegistry.value.getProviders
          : [];
        const configuredGlobal = settings.defaultModelSelection;
        const result = resolveModelSelection(
          {
            message:
              explicit !== undefined &&
              isPickedModelUsable(
                settings,
                projectId,
                Option.isSome(providerRegistry) ? providers : undefined,
                explicit,
              )
                ? explicit
                : undefined,
            assistantProject:
              assistantId === undefined
                ? undefined
                : settings.projectSettingsOverrides[projectId]?.assistantModelSelections?.[
                    assistantId
                  ],
            project: projectModelLayer(
              resolved.sources.defaultModelSelection,
              resolved.settings.defaultModelSelection,
            ),
            team,
            assistant,
            global: (configuredGlobal !== null && isUsable(configuredGlobal)
              ? configuredGlobal
              : null) ??
              firstUsableProviderModel(providers) ?? {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_MODEL,
              },
          },
          isUsable,
        );
        yield* Effect.annotateCurrentSpan({
          "model_selection.layer": result.layer,
          "model_selection.instance_id": result.selection.instanceId,
        });
        return result;
      },
      Effect.mapError((cause) => new ProjectModelSelectionError({ cause })),
    );

  return ProjectModelSelectionService.of({ resolveForNewThread });
});

export const layer = Layer.effect(ProjectModelSelectionService, make);
