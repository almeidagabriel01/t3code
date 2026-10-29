import { describe, expect, it } from "vite-plus/test";

import {
  countLivePortsByProject,
  resolveSubagentDisplay,
  toggleHoverCardProperty,
} from "./sidebarDisplay.logic";

describe("resolveSubagentDisplay", () => {
  const base = { show: true, mode: "compact", expanded: false } as const;

  it("hides everything when the setting is off or there are no children", () => {
    expect(resolveSubagentDisplay({ ...base, show: false, count: 3 })).toBe("hidden");
    expect(resolveSubagentDisplay({ ...base, count: 0 })).toBe("hidden");
  });

  it("lists up to three children and folds more into a summary in compact mode", () => {
    expect(resolveSubagentDisplay({ ...base, count: 3 })).toBe("rows");
    expect(resolveSubagentDisplay({ ...base, count: 4 })).toBe("summary");
    expect(resolveSubagentDisplay({ ...base, count: 4, expanded: true })).toBe("summary-and-rows");
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

describe("countLivePortsByProject", () => {
  it("sums merged members and omits projects without ports", () => {
    const counts = countLivePortsByProject(
      [{ projectId: "a1" }, { projectId: "a2" }, { projectId: "a2" }, { projectId: null }],
      [
        { projectKey: "a", memberProjects: [{ id: "a1" }, { id: "a2" }] },
        { projectKey: "b", memberProjects: [{ id: "b1" }] },
      ],
    );
    expect([...counts]).toEqual([["a", 3]]);
  });
});
