import {
  type Assistant,
  type AssistantTeam,
  assistantGroupProjectIds,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";

import type { ProjectSettingSource } from "./projectSettings.ts";

const OPTIONAL_LAYERS = [
  "message",
  "thread",
  "assistantProject",
  "project",
  "team",
  "assistant",
] as const;

export type ModelSelectionLayer = (typeof OPTIONAL_LAYERS)[number] | "global";

export type ModelSelectionLayers = {
  readonly [Layer in (typeof OPTIONAL_LAYERS)[number]]?: ModelSelection | undefined;
} & { readonly global: ModelSelection };

/** What a server says its providers offer, custom models included (`ServerProvider`). */
export type ProviderModelListing = ReadonlyArray<{
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<{ readonly slug: string }>;
}>;

/**
 * Whether a model a client or an agent picked can run in a project, ruled the same on the server,
 * which falls back from one it cannot, and on the client, which then shows that fallback. Its
 * provider must be on there and list the model; a list still empty (a provider probing, a server
 * starting) cannot tell, so only the first holds.
 */
export function isPickedModelUsable(
  settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0],
  projectId: ProjectId | null,
  providers: ProviderModelListing | undefined,
  selection: ModelSelection,
): boolean {
  if (!resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)) {
    return false;
  }
  if (providers === undefined || providers.length === 0) return true;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return (
    provider !== undefined &&
    (provider.models.length === 0 ||
      provider.models.some((model) => model.slug === selection.model))
  );
}

/** The first present, usable layer wins in `OPTIONAL_LAYERS` order; `global` is the last resort. */
export function resolveModelSelection(
  layers: ModelSelectionLayers,
  isUsable: (selection: ModelSelection) => boolean,
): { readonly selection: ModelSelection; readonly layer: ModelSelectionLayer } {
  for (const layer of OPTIONAL_LAYERS) {
    const selection = layers[layer];
    if (selection !== undefined && isUsable(selection)) return { selection, layer };
  }
  return { selection: layers.global, layer: "global" };
}

/** A project's own default; a resolved value that comes from the environment is `global`'s. */
export function projectModelLayer(
  source: ProjectSettingSource | "mixed",
  selection: ModelSelection | null,
): ModelSelection | undefined {
  return source === "environment" ? undefined : (selection ?? undefined);
}

/** A group's default holds only in its effective projects: its own plus its members'. */
export function teamModelLayer(
  team: Pick<AssistantTeam, "defaultModelSelection" | "projectIds">,
  members: ReadonlyArray<Pick<Assistant, "projectId" | "projectIds">>,
  projectId: ProjectId,
): ModelSelection | undefined {
  const effective = assistantGroupProjectIds(members, team.projectIds);
  return effective.length > 0 && !effective.includes(projectId)
    ? undefined
    : (team.defaultModelSelection ?? undefined);
}
