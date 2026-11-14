import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ModelSelectionLayer,
  type ModelSelectionLayers,
  resolveModelSelection,
} from "./modelSelectionPrecedence.ts";

const pick = (model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model,
});
const all: ModelSelectionLayers = {
  message: pick("message"),
  thread: pick("thread"),
  assistantProject: pick("assistantProject"),
  project: pick("project"),
  team: pick("team"),
  assistant: pick("assistant"),
  global: pick("global"),
};
const order = [
  "message",
  "thread",
  "assistantProject",
  "project",
  "team",
  "assistant",
  "global",
] as const satisfies ReadonlyArray<ModelSelectionLayer>;
const without = (dropped: ReadonlyArray<ModelSelectionLayer>): ModelSelectionLayers =>
  Object.fromEntries(
    Object.entries(all).filter(([layer]) => !dropped.includes(layer as ModelSelectionLayer)),
  ) as ModelSelectionLayers;

describe("resolveModelSelection", () => {
  it.each(order.map((layer, index) => [layer, order.slice(0, index)] as const))(
    "%s wins over every later layer",
    (layer, absent) => {
      expect(resolveModelSelection(without(absent), () => true)).toEqual({
        selection: pick(layer),
        layer,
      });
    },
  );

  it.each([
    ["message", "thread"],
    ["thread", "assistantProject"],
    ["assistantProject", "project"],
    ["project", "team"],
    ["team", "assistant"],
    ["assistant", "global"],
  ] as const)("skips an unusable %s for %s", (unusable, expected) => {
    expect(
      resolveModelSelection(
        without(order.slice(0, order.indexOf(unusable))),
        (selection) => selection.model !== unusable,
      ),
    ).toEqual({ selection: pick(expected), layer: expected });
  });

  it("falls back to global even when nothing is usable", () => {
    expect(resolveModelSelection(all, () => false)).toEqual({
      selection: pick("global"),
      layer: "global",
    });
    expect(resolveModelSelection({ global: pick("global") }, () => true)).toEqual({
      selection: pick("global"),
      layer: "global",
    });
  });
});
