import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_QUICK_BUTTONS,
  customizerQuickButtons,
  moveQuickButton,
  setQuickButtonShown,
  visibleQuickButtons,
  type QuickButtonId,
} from "./rightPanelQuickButtons.logic";

const everything = {
  files: true,
  diff: true,
  terminal: true,
  preview: true,
  "pull-requests": true,
  "pull-request": true,
  notes: true,
  "side-chat": true,
  device: true,
} satisfies Record<QuickButtonId, boolean>;

describe("right panel quick buttons", () => {
  it("shows today's five by default", () => {
    expect(visibleQuickButtons(DEFAULT_QUICK_BUTTONS, everything)).toEqual([
      "files",
      "diff",
      "terminal",
      "preview",
      "pull-requests",
    ]);
  });

  it("keeps saved order, drops unknown and repeated ids, hides unavailable additions only", () => {
    const saved = ["notes", "future", "diff", "notes", "device", "files"];
    const available = { ...everything, notes: false, diff: false };
    expect(visibleQuickButtons(saved, available)).toEqual(["diff", "device", "files"]);
  });

  it("toggles and moves while keeping ids from other app versions", () => {
    const added = setQuickButtonShown(["files", "future"], "notes", true);
    expect(added).toEqual(["files", "future", "notes"]);
    expect(moveQuickButton(added, "notes", -1)).toEqual(["notes", "files", "future"]);
    expect(moveQuickButton(added, "files", -1)).toEqual(added);
    expect(setQuickButtonShown(added, "files", false)).toEqual(["future", "notes"]);
  });

  it("lists shown buttons first in the customizer, then the rest", () => {
    expect(customizerQuickButtons(["notes", "files"]).slice(0, 3)).toEqual([
      "notes",
      "files",
      "diff",
    ]);
  });
});
