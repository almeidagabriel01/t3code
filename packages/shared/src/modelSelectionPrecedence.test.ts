import { ProviderInstanceId, type ModelSelection, type ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ModelSelectionLayer,
  type ModelSelectionLayers,
  projectModelLayer,
  resolveModelSelection,
  teamModelLayer,
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

describe("project and team layers", () => {
  it.each([
    ["environment", pick("x"), undefined],
    ["project", pick("x"), pick("x")],
    ["folder", pick("x"), pick("x")],
    ["t3.json", null, undefined],
  ] as const)("a %s default is the project layer: %j", (source, selection, expected) => {
    expect(projectModelLayer(source, selection)).toEqual(expected);
  });

  const p = (id: string) => id as ProjectId;
  const member = { projectId: p("home"), projectIds: [p("a")] };
  it.each([
    ["the group's own project", [p("g")], [member], "g", pick("team")],
    ["a member's project", [p("g")], [member], "a", pick("team")],
    ["a project outside the group", [p("g")], [member], "elsewhere", undefined],
    ["any project of a group with none", [], [], "elsewhere", pick("team")],
  ] as const)("the group's default holds in %s", (_, projectIds, members, projectId, expected) => {
    expect(
      teamModelLayer({ defaultModelSelection: pick("team"), projectIds }, members, p(projectId)),
    ).toEqual(expected);
    expect(teamModelLayer({ projectIds }, members, p(projectId))).toBeUndefined();
  });
});
