import { describe, expect, it } from "vite-plus/test";

import { reuseEntries, sameStamped } from "./stableEntries";

const record = (id: string, updatedAt = "1") => ({ id, updatedAt });
const reuse = (
  previous: ReadonlyArray<ReturnType<typeof record>> | undefined,
  next: ReadonlyArray<ReturnType<typeof record>>,
) => reuseEntries(previous, next, (entry) => entry.id, sameStamped);

describe("reuseEntries", () => {
  it("keeps the previous list when a snapshot rebuilds the same records", () => {
    const previous = [record("a"), record("b")];
    expect(reuse(previous, [record("a"), record("b")])).toBe(previous);
  });

  it("keeps unchanged entries and takes the changed one, in the new order", () => {
    const previous = [record("a"), record("b"), record("c")];
    const changed = record("b", "2");
    const next = reuse(previous, [record("c"), changed, record("a")]);
    expect(next).not.toBe(previous);
    expect(next[0]).toBe(previous[2]);
    expect(next[1]).toBe(changed);
    expect(next[2]).toBe(previous[0]);
  });

  it("returns a new list when an entry leaves or the first derivation runs", () => {
    const previous = [record("a"), record("b")];
    const next = reuse(previous, [record("a")]);
    expect(next).toEqual([previous[0]]);
    expect(next[0]).toBe(previous[0]);
    const first = [record("a")];
    expect(reuse(undefined, first)).toBe(first);
  });
});
