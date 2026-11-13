import { describe, expect, it } from "vite-plus/test";

import { assistantClusterLayout } from "./assistantCluster.ts";

const at = (cells: ReadonlyArray<{ left: number; top: number; size: number }>) =>
  cells.map(({ left, top, size }) => `${left},${top}:${size}`);

describe("assistantClusterLayout", () => {
  it.each([
    { count: 0, faces: [], more: null },
    { count: 1, faces: ["0,0:100"], more: null },
    { count: 2, faces: ["0,26:48", "52,26:48"], more: null },
    { count: 3, faces: ["26,0:48", "0,52:48", "52,52:48"], more: null },
    { count: 4, faces: ["0,0:48", "52,0:48", "0,52:48", "52,52:48"], more: null },
    { count: 5, faces: ["0,0:48", "52,0:48", "0,52:48"], more: 2 },
    { count: 6, faces: ["0,0:48", "52,0:48", "0,52:48"], more: 3 },
    { count: 12, faces: ["0,0:48", "52,0:48", "0,52:48"], more: 9 },
  ])("$count faces", ({ count, faces, more }) => {
    const layout = assistantClusterLayout(count);
    expect(at(layout.faces)).toEqual(faces);
    expect(layout.more?.count ?? null).toBe(more);
    if (layout.more) expect(at([layout.more.cell])).toEqual(["52,52:48"]);
  });
});
