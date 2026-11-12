import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const open = vi.fn();
vi.mock("../../rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ open }) } }));

import { projectPanelPaletteItems } from "./projectPanelPaletteItems";

describe("projectPanelPaletteItems", () => {
  it("offers nothing without an open thread", () => {
    expect(projectPanelPaletteItems(null)).toEqual([]);
  });

  it("opens each project panel beside the open thread", async () => {
    const thread = { environmentId: "env" as EnvironmentId, id: "t1" as ThreadId };
    const items = projectPanelPaletteItems(thread);
    expect(items.map((item) => item.title)).toEqual([
      "Show project activity in panel",
      "Show project memory in panel",
      "Show project heavy work in panel",
    ]);
    for (const item of items) await item.run();
    expect(open.mock.calls).toEqual([
      [scopeThreadRef(thread.environmentId, thread.id), "activity"],
      [scopeThreadRef(thread.environmentId, thread.id), "memory"],
      [scopeThreadRef(thread.environmentId, thread.id), "heavy-work"],
    ]);
  });
});
