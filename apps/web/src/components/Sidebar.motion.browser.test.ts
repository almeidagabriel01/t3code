import { describe, expect, it } from "vite-plus/test";

import { createSidebarListMotion } from "./Sidebar.motion";

function row() {
  const node = document.createElement("li");
  node.style.height = "28px";
  return node;
}

function setup(rows: number) {
  const list = document.createElement("ul");
  list.style.position = "relative";
  list.append(...Array.from({ length: rows }, row));
  document.body.append(list);
  const motion = createSidebarListMotion(list);
  motion.update(false);
  return {
    list,
    motion,
    [Symbol.dispose]() {
      motion.dispose();
      list.remove();
    },
  };
}

const animationCount = (list: HTMLElement) =>
  [list, ...list.querySelectorAll("*")].reduce(
    (count, node) => count + node.getAnimations().length,
    0,
  );

describe("createSidebarListMotion", () => {
  it.each([
    { name: "collapsing", before: 3, after: 0 },
    { name: "expanding", before: 0, after: 3 },
  ])("does not animate a project $name", ({ before, after }) => {
    using fixture = setup(before);
    fixture.list.replaceChildren(...Array.from({ length: after }, row));
    fixture.motion.update(true);
    expect(fixture.list.children).toHaveLength(after);
    expect(animationCount(fixture.list)).toBe(0);
  });

  it("still fades a row removed from a populated list", () => {
    using fixture = setup(3);
    fixture.list.lastElementChild!.remove();
    fixture.motion.update(true);
    expect(fixture.list.children).toHaveLength(3);
    expect(animationCount(fixture.list)).toBeGreaterThan(0);
  });
});
