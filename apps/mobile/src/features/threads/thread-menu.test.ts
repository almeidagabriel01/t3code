import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildSnoozePresetActions,
  buildThreadMenuActions,
  menuActionsToAppBarItems,
  resolveThreadMenuKind,
  runThreadMenuEvent,
  type ThreadMenuHandlers,
  type ThreadMenuInput,
} from "./thread-menu";

const input: ThreadMenuInput = {
  kind: "card",
  newThreadOnBranchTitle: "New thread on main",
  pinned: false,
  pinningSupported: true,
  autoSettle: { supported: true, enabled: true },
  titleRegeneration: { supported: true, regenerating: false },
  canHandoff: true,
  turnIntoProject: null,
  snoozePresetActions: buildSnoozePresetActions([
    { id: "1h", label: "1 hour", whenLabel: "10:00" },
  ]),
};
const ids = (overrides: Partial<ThreadMenuInput> = {}) =>
  buildThreadMenuActions({ ...input, ...overrides }).map((action) => action.id);

describe("thread menu", () => {
  it("picks the menu kind the list uses", () => {
    const base = { snoozed: false, settlementSupported: true, settled: false, snoozable: false };
    expect(resolveThreadMenuKind({ ...base, snoozed: true, settled: true })).toBe("snoozed");
    expect(resolveThreadMenuKind({ ...base, settlementSupported: false })).toBe("legacy");
    expect(resolveThreadMenuKind({ ...base, settled: true })).toBe("slim");
    expect(resolveThreadMenuKind({ ...base, snoozable: true })).toBe("snoozableCard");
    expect(resolveThreadMenuKind(base)).toBe("card");
  });

  it("offers handoff only when the thread can be handed off", () => {
    expect(ids()).toContain("handoff");
    expect(ids({ canHandoff: false })).not.toContain("handoff");
  });

  it("builds the full card menu in order, ending with archive and delete", () => {
    expect(ids()).toEqual([
      "new-thread-on-branch",
      "copy-thread",
      "copy-thread-id",
      "settle",
      "pin",
      "rename",
      "regenerate-title",
      "handoff",
      "auto-settle",
      "archive",
      "delete",
    ]);
  });

  it("adds snooze only for snoozable cards and un-settle only for settled ones", () => {
    expect(ids({ kind: "snoozableCard" })).toContain("snooze");
    expect(ids()).not.toContain("snooze");
    expect(ids({ kind: "slim" })).toContain("unsettle");
    expect(ids({ kind: "snoozed" })).toContain("unsnooze");
  });

  it("shows arranging only for the list and swaps pin for unpin", () => {
    expect(ids()).not.toContain("arrange");
    expect(ids({ reorder: { canMoveUp: true, canMoveDown: false } })).toEqual(
      expect.arrayContaining(["arrange", "move-up", "move-down"]),
    );
    expect(ids({ pinned: true })).toContain("unpin");
  });

  it("routes events to handlers, including snooze presets", () => {
    const handlers = Object.fromEntries(
      [
        "copyThread",
        "copyThreadId",
        "settle",
        "unsettle",
        "unsnooze",
        "pin",
        "unpin",
        "setAutoSettle",
        "archive",
        "rename",
        "regenerateTitle",
        "handoff",
        "turnIntoProject",
        "delete",
        "openCustomSnooze",
        "snooze",
        "snoozeExpired",
      ].map((name) => [name, vi.fn()]),
    ) as unknown as ThreadMenuHandlers;
    const snooze = { displayedPresets: [], presets: undefined, now: new Date(0) };

    runThreadMenuEvent("handoff", handlers, snooze);
    runThreadMenuEvent("auto-settle:disabled", handlers, snooze);
    runThreadMenuEvent("delete", handlers, snooze);
    runThreadMenuEvent("snooze:custom", handlers, snooze);
    runThreadMenuEvent("arrange", handlers, snooze);

    expect(handlers.handoff).toHaveBeenCalledTimes(1);
    expect(handlers.setAutoSettle).toHaveBeenCalledWith(false);
    expect(handlers.delete).toHaveBeenCalledTimes(1);
    expect(handlers.openCustomSnooze).toHaveBeenCalledTimes(1);
    expect(handlers.snooze).not.toHaveBeenCalled();
  });

  it("converts menu actions for the header, keeping ids, submenus and state", () => {
    const pressed: string[] = [];
    const items = menuActionsToAppBarItems(
      buildThreadMenuActions({ ...input, kind: "snoozableCard" }),
      (id) => pressed.push(id),
    );
    const autoSettle = items.find((item) => item.id === "auto-settle");
    expect(autoSettle && "items" in autoSettle ? autoSettle.items : []).toMatchObject([
      { id: "auto-settle:enabled", selected: true },
      { id: "auto-settle:disabled", selected: false },
    ]);
    const handoff = items.find((item) => item.id === "handoff");
    if (handoff && "onPress" in handoff) handoff.onPress();
    expect(pressed).toEqual(["handoff"]);
  });
});
