import { expect, it } from "@effect/vitest";

import { parseUserGuide, searchUserGuides } from "./userGuides.ts";

const memory = parseUserGuide(
  "memory",
  [
    "# Memory",
    "",
    "Intro about remembering things.",
    "",
    "## Turn off summaries",
    "",
    "Open Settings and switch memory summaries off.",
    "",
    "```sh",
    "## not a heading",
    "```",
    "",
    "## Import",
    "",
    "Bring memories from Claude. Mentions summaries once, far down in the body.",
    "",
    "## Import",
    "",
    "Second import section.",
  ].join("\n"),
);
const notes = parseUserGuide("notes", "# Notes\n\n## Pinning\n\nPin a note to keep it on top.\n");

it("reads title, lead and sections, skipping headings inside fences and de-duplicating anchors", () => {
  expect(memory.title).toBe("Memory");
  expect(memory.lead).toBe("Intro about remembering things.");
  expect(memory.sections.map((section) => section.anchor)).toEqual([
    "turn-off-summaries",
    "import",
    "import-1",
  ]);
  expect(memory.sections[0]?.text).toContain("## not a heading");
});

it("ranks a heading match above a body match, ignores filler words and keeps snippets short", () => {
  const { words, matches } = searchUserGuides(
    [notes, memory],
    "how do I turn off the memory summaries",
  );
  expect(words).toEqual(["turn", "off", "memory", "summaries"]);
  expect(matches[0]).toMatchObject({ page: "memory", heading: "Turn off summaries" });
  expect(matches.every((match) => match.snippet.length <= 250)).toBe(true);
  expect(searchUserGuides([notes, memory], "the of").matches).toEqual([]);
  expect(searchUserGuides([notes, memory], "pin").matches[0]).toMatchObject({ page: "notes" });
});
