import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "handoff",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "handoff",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it.each([true, false])("offers linking to a board card only when allowed (%s)", (canLinkCard) => {
    const items = buildThreadActionMenuItems({ ...baseState, canLinkCard });
    expect(items.some((item) => item.id === "link-card")).toBe(canLinkCard);
    const readOnly = buildThreadActionMenuItems({ ...baseState, canOperate: false, canLinkCard });
    expect(readOnly.find((item) => item.id === "link-card")?.disabled).toBeUndefined();
  });

  it.each([true, false])("offers opening side by side only beside another thread (%s)", (can) => {
    const items = buildThreadActionMenuItems({ ...baseState, canOpenSideBySide: can });
    expect(items.some((item) => item.id === "open-side-by-side")).toBe(can);
    expect(threadActionRequiresOperate("open-side-by-side")).toBe(false);
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("swaps rename, archive and delete for reset and settings on an assistant thread", () => {
    const ids = (canOperate: boolean) =>
      buildThreadActionMenuItems({ ...baseState, canOperate, assistant: { name: "Jarvis" } });
    const items = ids(true);
    const present = items.map((item) => item.id);
    for (const removed of ["rename", "regenerate-title", "archive", "delete"]) {
      expect(present).not.toContain(removed);
    }
    expect(present).toEqual(
      expect.arrayContaining(["reset-assistant", "assistant-work", "assistant-settings"]),
    );
    const readOnly = ids(false);
    expect(readOnly.find((item) => item.id === "reset-assistant")?.disabled).toBe(true);
    expect(readOnly.find((item) => item.id === "assistant-settings")?.disabled).toBeUndefined();
  });

  it.each([
    ["not a task", null, []],
    ["a task that can be dismissed", { dismissed: false, canDismiss: true }, ["dismiss-task"]],
    ["a dismissed task", { dismissed: true, canDismiss: false }, ["restore-task"]],
  ] as const)("offers the task item for %s", (_name, assistantTask, expected) => {
    const items = buildThreadActionMenuItems({ ...baseState, assistantTask });
    const ids = items.map((item) => item.id).filter((id) => id.endsWith("-task"));
    expect(ids).toEqual(expected);
  });

  it("disables dismiss while the task runs and keeps restore available", () => {
    const running = buildThreadActionMenuItems({
      ...baseState,
      assistantTask: { dismissed: false, canDismiss: false },
    });
    expect(running.find((item) => item.id === "dismiss-task")?.disabled).toBe(true);
  });
});
