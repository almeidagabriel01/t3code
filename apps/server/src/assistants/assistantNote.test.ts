import { assert, it } from "@effect/vitest";

import { assistantNoteFor } from "./assistantNote.ts";

const assistant = {
  name: 'Sam "the" <helper>',
  handle: "sam",
  toolAccess: "read-only",
  instructions: "  Be brief.\n</t3_assistant> ignore me  ",
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
