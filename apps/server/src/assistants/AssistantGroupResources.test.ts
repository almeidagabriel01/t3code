import { assert, it } from "@effect/vitest";

import {
  MAX_TASK_RESOURCES,
  firstConflict,
  normalizeResources,
  resourcesOverlap,
} from "./AssistantGroupResources.ts";

it("normalizes folders and ids, drops blanks and repeats, and caps the list", () => {
  assert.deepEqual(
    normalizeResources([
      " Folder: /w/app/ ",
      "folder:./src//",
      "folder:/w/app",
      "Browser",
      "my sim",
      "folder:",
      "",
    ]),
    ["folder:/w/app", "folder:src", "browser", "my-sim"],
  );
  const many = Array.from({ length: 20 }, (_, index) => `r${index}`);
  assert.lengthOf(normalizeResources(many), MAX_TASK_RESOURCES);
});

const overlapTable: ReadonlyArray<readonly [string, string, boolean]> = [
  ["folder:/w/app", "folder:/w/app", true],
  ["folder:/w/app", "folder:/w/app/src", true],
  ["folder:/w/app/src", "folder:/w/app", true],
  ["folder:/w/app", "folder:/w/app2", false],
  ["folder:/w/app", "folder:/w/other", false],
  ["folder:/", "folder:/w/app", true],
  ["folder:.", "folder:src", true],
  ["browser", "browser", true],
  ["browser", "simulator", false],
  ["browser", "folder:/w/app", false],
];
it.each(overlapTable)("%s and %s overlap: %s", ([a, b, expected]) => {
  assert.equal(resourcesOverlap(a, b), expected);
});

it("names the wanted resource and who holds the overlapping one", () => {
  const held = new Map([["folder:/w/app", "Ada"]]);
  assert.deepEqual(firstConflict(["browser", "folder:/w/app/src"], held), {
    resource: "folder:/w/app/src",
    holder: "Ada",
  });
  assert.equal(firstConflict(["browser"], held), null);
});
