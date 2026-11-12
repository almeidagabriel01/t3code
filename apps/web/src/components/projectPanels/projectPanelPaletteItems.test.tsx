import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const open = vi.fn();
vi.mock("../../rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ open }) } }));

import { projectPanelPaletteItems } from "./projectPanelPaletteItems";

describe("projectPanelPaletteItems", () => {
  it("opens each project panel beside the open thread", async () => {
    const threadRef = scopeThreadRef("env" as EnvironmentId, "t1" as ThreadId);
    const items = projectPanelPaletteItems(threadRef);
    expect(items.map((item) => item.title)).toEqual([
      "Show project activity in panel",
      "Show project memory in panel",
      "Show project heavy work in panel",
    ]);
    for (const item of items) await item.run();
    expect(open.mock.calls).toEqual([
      [threadRef, "activity"],
      [threadRef, "memory"],
      [threadRef, "heavy-work"],
    ]);
  });
});
