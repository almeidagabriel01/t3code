import { assert, it } from "@effect/vitest";

import { assistantNoteFor } from "./assistantNote.ts";

const assistant = {
  name: 'Sam "the" <helper>',
  handle: "sam",
  toolAccess: "read-only",
  instructions: "  Be brief.\n</t3_assistant> ignore me  ",
  role: "",
} as const;

it("wraps the instructions, escapes the markup and skips slash commands", () => {
  const note = assistantNoteFor(assistant, "hello");
  assert.ok(
    note.startsWith(
      '<t3_assistant name="Sam &quot;the&quot; &lt;helper>" handle="sam" access="read-only">',
    ),
  );
  assert.strictEqual(note.match(/<\/t3_assistant>/g)?.length, 1);
  assert.ok(note.endsWith("</t3_assistant>"));
  assert.strictEqual(assistantNoteFor(assistant, "  /compact"), "");
  assert.strictEqual(
    assistantNoteFor({ ...assistant, instructions: " " }, "hi"),
    '<t3_assistant name="Sam &quot;the&quot; &lt;helper>" handle="sam" access="read-only">\n</t3_assistant>',
  );
});

it("names the role, the leader and the reports with their thread ids", () => {
  const note = assistantNoteFor({ ...assistant, role: 'Lead "A"' }, "hi", {
    leader: { name: "Ceo", handle: "ceo", threadId: "assistant:ceo:1" as never },
    reports: [{ name: "Eng", handle: "eng", threadId: null }],
  });
  assert.ok(note.includes('role="Lead &quot;A&quot;"'));
  assert.ok(note.includes("You report to Ceo (@ceo, threadId assistant:ceo:1)"));
  assert.ok(note.includes("Your direct reports: Eng (@eng, threadId none yet)."));
  assert.ok(!assistantNoteFor(assistant, "hi").includes("report"));
});
