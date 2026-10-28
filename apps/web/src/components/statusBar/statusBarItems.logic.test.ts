import { describe, expect, it } from "vite-plus/test";

import {
  displayedPercent,
  isStatusBarItemShown,
  toggleStatusBarItem,
} from "./statusBarItems.logic";

describe("status bar item visibility", () => {
  it("shows every item that is not in the hidden list, including ones added later", () => {
    expect(isStatusBarItemShown([], "claudeAgent_new")).toBe(true);
    expect(isStatusBarItemShown(["ports"], "ports")).toBe(false);
    expect(isStatusBarItemShown(["ports"], "resource-usage")).toBe(true);
  });

  it("toggles an id in and out of the hidden list without touching the rest", () => {
    expect(toggleStatusBarItem(["ports"], "claudeAgent")).toEqual(["ports", "claudeAgent"]);
    expect(toggleStatusBarItem(["ports", "claudeAgent"], "ports")).toEqual(["claudeAgent"]);
  });
});

describe("displayedPercent", () => {
  it("shows used or remaining, clamped", () => {
    expect(displayedPercent(72.4, "used")).toBe(72);
    expect(displayedPercent(72.4, "remaining")).toBe(28);
    expect(displayedPercent(130, "remaining")).toBe(0);
  });
});
