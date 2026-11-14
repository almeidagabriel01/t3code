import type { ModelSelection } from "@t3tools/contracts";

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
