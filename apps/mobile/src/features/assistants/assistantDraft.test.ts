import {
  DEFAULT_ASSISTANT_AUTONOMY,
  type Assistant,
  type AssistantTeam,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  assistantDraftFor,
  assistantEditorAtom,
  assistantInGroup,
  avatarImageProblem,
  setAssistantGroup,
  startAssistantEditor,
  teamMembershipUpdates,
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
  role: "",
  budget: null,
  askBeforeActing: false,
  workspace: "host",
  icon: null,
  avatar: null,
  scope: "all",
  autonomy: DEFAULT_ASSISTANT_AUTONOMY,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Assistant;

const appAssistantEditor = () => appAtomRegistry.get(assistantEditorAtom)!;

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
    expect(assistantUpdateInput(editorFor(assistant), ["p1" as ProjectId])).toEqual({
      assistantId: "a1",
    });
    expect(
      assistantUpdateInput(
        editorFor(assistant, { name: " Scout 2 ", toolAccess: "full", modelSelection: model }),
        [project],
      ),
    ).toEqual({
      assistantId: "a1",
      name: "Scout 2",
      projectId: "p2",
      modelSelection: model,
      toolAccess: "full",
    });
    expect(
      assistantUpdateInput(editorFor(assistant, { askBeforeActing: true }), ["p1" as ProjectId]),
    ).toEqual({ assistantId: "a1", askBeforeActing: true });
  });

  it("sends a list of projects when several are picked, and only when the pick changed", () => {
    const two = ["p1", "p2"] as ProjectId[];
    expect(assistantUpdateInput(editorFor(assistant), two)).toEqual({
      assistantId: "a1",
      projectId: "p1",
      projectIds: two,
    });
    const listed = { ...assistant, scope: "project", projectIds: two } as Assistant;
    expect(assistantUpdateInput(editorFor(listed), [...two].reverse())).toEqual({
      assistantId: "a1",
    });
    expect(assistantCreateInput(editorFor(null, { name: "Scout" }), two)).toMatchObject({
      projectId: "p1",
      projectIds: two,
    });
  });

  it("sends the whole form when creating, with the derived handle", () => {
    expect(assistantCreateInput(editorFor(null, { name: "Scout" }), ["p1" as ProjectId])).toEqual({
      name: "Scout",
      handle: "scout",
      projectId: "p1",
      instructions: "",
      toolAccess: "workspace-write",
      askBeforeActing: true,
      avatar: { kind: "robot", hue: 210, variant: 0 },
    });
  });

  it("sends the robot avatar on create unless a picture waits, and on update only when touched", () => {
    const file = { kind: "file", file: { previewUri: "x" } } as never;
    const picked = { avatar: { hue: 30, variant: 2 }, avatarImage: file };
    expect(
      assistantCreateInput(editorFor(null, { name: "S", ...picked }), ["p1" as ProjectId]),
    ).not.toHaveProperty("avatar");
    expect(
      assistantCreateInput(editorFor(null, { name: "S", avatar: { hue: 30, variant: 2 } }), [
        "p1" as ProjectId,
      ]),
    ).toMatchObject({ avatar: { kind: "robot", hue: 30, variant: 2 } });
    const shuffled = { avatar: { hue: 150, variant: 5 }, avatarTouched: true };
    expect(assistantUpdateInput(editorFor(assistant, shuffled), ["p1" as ProjectId])).toEqual({
      assistantId: "a1",
      avatar: { kind: "robot", hue: 150, variant: 5 },
    });
    expect(
      assistantUpdateInput(editorFor(assistant, { ...shuffled, avatarImage: file }), [
        "p1" as ProjectId,
      ]),
    ).toEqual({ assistantId: "a1" });
    // A picked file counts as a change by its id, and the same file on both sides does not.
    const pickedFile = (id: string) => ({ kind: "file", file: { id } }) as never;
    expect(
      assistantDraftHasChanges({
        ...editorFor(assistant, { avatarImage: pickedFile("f1") }),
        initial: { ...assistantDraftFor(assistant), avatarImage: pickedFile("f1") },
      }),
    ).toBe(false);
    expect(assistantDraftHasChanges(editorFor(assistant, { avatarImage: pickedFile("f1") }))).toBe(
      true,
    );
    expect(
      assistantDraftHasChanges(editorFor(assistant, { avatarImage: { kind: "stored" } })),
    ).toBe(true);
    // Untouched, the stored avatar is never overwritten.
    expect(assistantUpdateInput(editorFor(assistant), ["p1" as ProjectId])).toEqual({
      assistantId: "a1",
    });
  });

  it("starts a new assistant on Edit files and ask before acting, from a preset", () => {
    expect(assistantDraftFor(null)).toMatchObject({
      toolAccess: "workspace-write",
      askBeforeActing: true,
      projectIds: null,
      avatarImage: null,
      avatarTouched: false,
      groupChoices: {},
    });
    expect(
      assistantDraftFor(null, { projectId: "p9" as ProjectId, teamId: "t9" as never }),
    ).toMatchObject({ projectIds: ["p9"], groupChoices: { t9: true } });
    // An existing assistant keeps what it has, and a stored picture is kept as is.
    expect(assistantDraftFor(assistant, { projectId: "p9" as ProjectId })).toMatchObject({
      toolAccess: "read-only",
      askBeforeActing: false,
      projectIds: ["p1"],
      groupChoices: {},
    });
    const listed = {
      ...assistant,
      scope: "project",
      projectIds: ["p1", "p2"],
    } as unknown as Assistant;
    expect(assistantDraftFor(listed).projectIds).toEqual(["p1", "p2"]);
    const withImage = { ...assistant, avatar: { kind: "image", revision: 2 } } as Assistant;
    expect(assistantDraftFor(withImage).avatarImage).toEqual({ kind: "stored" });
  });

  it.each([
    ["image/png", 1024, null],
    ["IMAGE/JPEG", 1024, null],
    ["image/webp", 2 * 1024 * 1024, null],
    ["image/gif", 1024, "Use a PNG, JPEG or WebP image."],
    ["image/png", 2 * 1024 * 1024 + 1, "The image must be under 2 MB."],
  ])("checks an avatar image of %s, %i bytes", (mimeType, sizeBytes, problem) => {
    expect(avatarImageProblem({ mimeType, sizeBytes })).toBe(problem);
  });

  it("tracks group choices against current membership", () => {
    const team = (id: string, memberIds: string[], leadId: string | null = null) =>
      ({ id, name: id, memberIds, leadId }) as unknown as AssistantTeam;
    const mine = team("t1", ["a1", "z"], "a1");
    const other = team("t2", ["z"]);
    const empty = team("t3", []);
    startAssistantEditor("env" as EnvironmentId, assistant);
    const editor = () => appAssistantEditor();
    expect(assistantInGroup(editor(), mine)).toBe(true);
    expect(assistantInGroup(editor(), other)).toBe(false);
    setAssistantGroup(mine, false);
    setAssistantGroup(other, true);
    expect(editor().current.groupChoices).toEqual({ t1: false, t2: true });
    expect(assistantDraftHasChanges(editor())).toBe(true);
    expect(
      teamMembershipUpdates([mine, other, empty], assistant.id, (t) =>
        assistantInGroup(editor(), t),
      ),
    ).toEqual([
      { teamId: "t1", memberIds: ["z"], leadId: null },
      { teamId: "t2", memberIds: ["z", "a1"] },
    ]);
    // Going back to where the form started forgets the choice, so it is no change.
    setAssistantGroup(mine, true);
    setAssistantGroup(other, false);
    expect(editor().current.groupChoices).toEqual({});
    expect(assistantDraftHasChanges(editor())).toBe(false);
    // A preset group is already ticked from the start, and unticking it is a change.
    startAssistantEditor("env" as EnvironmentId, null, { teamId: "t3" as never });
    expect(assistantInGroup(editor(), empty)).toBe(true);
    expect(assistantDraftHasChanges(editor())).toBe(false);
    setAssistantGroup(empty, false);
    expect(assistantInGroup(editor(), empty)).toBe(false);
    expect(assistantDraftHasChanges(editor())).toBe(true);
    // No editor open: nothing happens.
    appAtomRegistry.set(assistantEditorAtom, null);
    setAssistantGroup(empty, true);
  });

  it("sends ask before acting on create only when it is on", () => {
    const create = (askBeforeActing: boolean) =>
      assistantCreateInput(editorFor(null, { name: "S", askBeforeActing }), ["p1" as ProjectId]);
    expect(create(true)).toMatchObject({ askBeforeActing: true });
    expect(create(false)).not.toHaveProperty("askBeforeActing");
  });

  it("sends the workspace on create only when it is the sandbox, and on update only when it changed", () => {
    const create = (workspace: "host" | "sandbox") =>
      assistantCreateInput(editorFor(null, { name: "S", workspace }), ["p1" as ProjectId]);
    expect(create("sandbox")).toMatchObject({ workspace: "sandbox" });
    expect(create("host")).not.toHaveProperty("workspace");
    expect(
      assistantUpdateInput(editorFor(assistant, { workspace: "sandbox" }), ["p1" as ProjectId]),
    ).toEqual({ assistantId: "a1", workspace: "sandbox" });
    expect(assistantUpdateInput(editorFor(assistant, {}), ["p1" as ProjectId])).toEqual({
      assistantId: "a1",
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
      assistantCreateInput(editorFor(null, { name: "S" }), ["p1" as ProjectId]),
    ).not.toHaveProperty("budget");
    expect(
      assistantCreateInput(editorFor(null, { name: "S", budget: on }), ["p1" as ProjectId]),
    ).toMatchObject({ budget: { amountUsd: 5 } });
    expect(
      assistantUpdateInput(editorFor(assistant, { budget: on }), ["p1" as ProjectId]),
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
    expect(assistantUpdateInput(editorFor(limited, { budget: off }), ["p1" as ProjectId])).toEqual({
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

  it("sends the trimmed role only when it changed", () => {
    expect(
      assistantUpdateInput(editorFor(assistant, { role: " Lead " }), ["p1" as ProjectId]),
    ).toEqual({ assistantId: "a1", role: "Lead" });
    expect(
      assistantCreateInput(editorFor(null, { name: "S", role: " QA " }), ["p1" as ProjectId]),
    ).toMatchObject({ role: "QA" });
    expect(
      assistantCreateInput(editorFor(null, { name: "S" }), ["p1" as ProjectId]),
    ).not.toHaveProperty("role");
  });

  it("sends the whole autonomy object only when it differs, and an inherit round-trip is no change", () => {
    const notify = { ...DEFAULT_ASSISTANT_AUTONOMY, mode: "reply-and-notify" as const };
    const custom = { ...notify, rules: ["ciFailed" as const], channels: ["t3" as const] };
    expect(
      assistantCreateInput(editorFor(null, { name: "S" }), ["p1" as ProjectId]),
    ).not.toHaveProperty("autonomy");
    expect(
      assistantCreateInput(editorFor(null, { name: "S", autonomy: custom }), ["p1" as ProjectId]),
    ).toMatchObject({ autonomy: custom });
    expect(
      assistantUpdateInput(editorFor(assistant, { autonomy: notify }), ["p1" as ProjectId]),
    ).toMatchObject({ autonomy: notify });
    const saved = { ...assistant, autonomy: custom } as Assistant;
    const backToInherit = editorFor(saved, { autonomy: { ...custom, rules: null } });
    expect(assistantUpdateInput(backToInherit, ["p1" as ProjectId])).toMatchObject({
      autonomy: { rules: null, channels: ["t3"] },
    });
    expect(assistantDraftHasChanges(backToInherit)).toBe(true);
    const reordered = editorFor(saved, { autonomy: { ...custom, rules: [...custom.rules] } });
    expect(assistantDraftHasChanges(reordered)).toBe(false);
    expect(assistantUpdateInput(reordered, ["p1" as ProjectId])).toEqual({ assistantId: "a1" });
  });
});
