import { describe, expect, it } from "vite-plus/test";

import { resolveSubagentDisplay, toggleHoverCardProperty } from "./sidebarDisplay.logic";

describe("resolveSubagentDisplay", () => {
  const base = { show: true, mode: "compact", expanded: false } as const;

  it("hides everything when the setting is off or there are no children", () => {
    expect(resolveSubagentDisplay({ ...base, show: false, count: 3 })).toBe("hidden");
    expect(resolveSubagentDisplay({ ...base, count: 0 })).toBe("hidden");
  });

  it("folds several children into a summary in compact mode", () => {
    expect(resolveSubagentDisplay({ ...base, count: 3 })).toBe("summary");
    expect(resolveSubagentDisplay({ ...base, count: 3, expanded: true })).toBe("summary-and-rows");
    expect(resolveSubagentDisplay({ ...base, count: 1 })).toBe("rows");
  });

  it("lists every child in full mode", () => {
    expect(resolveSubagentDisplay({ ...base, mode: "full", count: 3 })).toBe("rows");
  });
});

describe("toggleHoverCardProperty", () => {
  it("keeps the canonical order", () => {
    expect(toggleHoverCardProperty(["path", "ports"], "terminals", true)).toEqual([
      "path",
      "terminals",
      "ports",
    ]);
    expect(toggleHoverCardProperty(["path", "ports"], "path", false)).toEqual(["ports"]);
  });
});
