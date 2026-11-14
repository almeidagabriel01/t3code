import {
  type Assistant,
  type AssistantTeam,
  assistantGroupProjectIds,
  type ModelSelection,
  type ProjectId,
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
