import { describe, expect, it } from "vite-plus/test";

import { filterNotes } from "./search.ts";

describe("filterNotes", () => {
  const rows = [
    { title: "Café plan", preview: "ship it", path: "ideas/cafe.md" },
    { title: "Groceries", preview: "milk and eggs", path: "groceries.md" },
  ];
  it("matches every term in title, preview, or path, ignoring case and accents form", () => {
    const titles = (query: string) => filterNotes(rows, query).map((r) => r.title);
    expect(filterNotes(rows, "  ")).toBe(rows);
    expect(titles("CAFÉ ship")).toEqual(["Café plan"]);
    expect(titles("eggs milk")).toEqual(["Groceries"]);
    expect(titles("ideas/")).toEqual(["Café plan"]);
    expect(titles("milk ship")).toEqual([]);
  });
});
