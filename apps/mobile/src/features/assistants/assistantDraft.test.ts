import type { Assistant, EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantDraftFor,
  assistantCreateInput,
  assistantUpdateInput,
  effectiveAssistantHandle,
  isAssistantHandleValid,
  type AssistantEditor,
} from "./assistantDraft";

const assistant = {
  id: "a1",
  handle: "scout",
  name: "Scout",
  projectId: "p1",
  instructions: "Be brief.",
  toolAccess: "read-only",
  isDefault: false,
  threadId: "assistant:a1:1",
  generation: 1,
  budget: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Assistant;

const editorFor = <A extends Assistant | null>(
  existing: A,
  change: Partial<AssistantEditor["current"]> = {},
) => {
  const initial = assistantDraftFor(existing);
  return {
    environmentId: "env" as EnvironmentId,
    assistant: existing,
    initial,
    current: { ...initial, ...change },
  };
};

describe("assistant draft", () => {
  it("derives a new assistant's handle from its name until one is typed", () => {
    expect(effectiveAssistantHandle({ ...assistantDraftFor(null), name: "Café Bot!" })).toBe(
      "cafe-bot",
    );
    expect(
      effectiveAssistantHandle({ ...assistantDraftFor(null), name: "Café Bot!", handle: "cb" }),
    ).toBe("cb");
    expect(isAssistantHandleValid("-bad")).toBe(false);
    expect(isAssistantHandleValid("ok-1")).toBe(true);
  });

  it("sends only what changed when editing", () => {
    const project = "p2" as ProjectId;
    const model = { instanceId: "codex", model: "gpt" } as unknown as ModelSelection;
    expect(assistantUpdateInput(editorFor(assistant), "p1" as ProjectId)).toEqual({
      assistantId: "a1",
    });
    expect(
      assistantUpdateInput(
        editorFor(assistant, { name: " Scout 2 ", toolAccess: "full", modelSelection: model }),
        project,
      ),
    ).toEqual({
      assistantId: "a1",
      name: "Scout 2",
      projectId: "p2",
      modelSelection: model,
      toolAccess: "full",
    });
  });

  it("sends the whole form when creating, with the derived handle", () => {
    expect(assistantCreateInput(editorFor(null, { name: "Scout" }), "p1" as ProjectId)).toEqual({
      name: "Scout",
      handle: "scout",
      projectId: "p1",
      instructions: "",
      toolAccess: "full",
    });
  });
});
