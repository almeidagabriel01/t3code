import type { Assistant, EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantDraftFor,
  assistantCreateInput,
  assistantUpdateInput,
  assistantDraftHasChanges,
  budgetDraftFor,
  budgetFromDraft,
  effectiveAssistantHandle,
  isBudgetDraftValid,
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

  it("turns the spending limit draft into a budget, or null when off", () => {
    const on = { ...budgetDraftFor(null), enabled: true, amount: "12.5" };
    expect(budgetFromDraft(budgetDraftFor(null), "UTC")).toBeNull();
    expect(budgetFromDraft(on, "UTC")).toEqual({
      amountUsd: 12.5,
      period: "monthly",
      warnAtPercent: 80,
      blockWhenExceeded: true,
      timeZone: "UTC",
    });
    expect(isBudgetDraftValid(budgetDraftFor(null))).toBe(true);
    for (const bad of [
      { amount: "" },
      { amount: "0" },
      { amount: "0.001" },
      { amount: "abc" },
      { warnAt: "0" },
      { warnAt: "101" },
      { warnAt: "1.5" },
    ]) {
      expect(isBudgetDraftValid({ ...on, ...bad })).toBe(false);
    }
  });

  it("sends the budget only when it changed, and null when switched off", () => {
    const on = { ...budgetDraftFor(null), enabled: true, amount: "5" };
    expect(
      assistantCreateInput(editorFor(null, { name: "S" }), "p1" as ProjectId),
    ).not.toHaveProperty("budget");
    expect(
      assistantCreateInput(editorFor(null, { name: "S", budget: on }), "p1" as ProjectId),
    ).toMatchObject({ budget: { amountUsd: 5 } });
    expect(
      assistantUpdateInput(editorFor(assistant, { budget: on }), "p1" as ProjectId),
    ).toMatchObject({ budget: { amountUsd: 5 } });
    const limited = {
      ...assistant,
      budget: {
        amountUsd: 5,
        period: "daily",
        warnAtPercent: 50,
        blockWhenExceeded: false,
        timeZone: "UTC",
      },
    } as Assistant;
    const off = { ...budgetDraftFor(limited.budget), enabled: false };
    expect(assistantUpdateInput(editorFor(limited, { budget: off }), "p1" as ProjectId)).toEqual({
      assistantId: "a1",
      budget: null,
    });
  });

  it("ignores leftovers in a switched-off limit when detecting changes", () => {
    expect(
      assistantDraftHasChanges(
        editorFor(assistant, { budget: { ...budgetDraftFor(null), amount: "9" } }),
      ),
    ).toBe(false);
    expect(
      assistantDraftHasChanges(
        editorFor(assistant, { budget: { ...budgetDraftFor(null), enabled: true } }),
      ),
    ).toBe(true);
  });
});
