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
  // Blank instructions leave only the standing task guidance in the block.
  const blank = assistantNoteFor({ ...assistant, instructions: " " }, "hi");
  assert.ok(blank.includes("t3_thread_launch"));
  assert.ok(blank.endsWith("\n</t3_assistant>"));
});

it("escapes the role into the opening tag", () => {
  const note = assistantNoteFor({ ...assistant, role: 'Lead "A"' }, "hi");
  assert.ok(note.includes('role="Lead &quot;A&quot;"'));
  assert.ok(!note.includes("report"));
});

it("tells an assistant that must ask before acting to wait and not route around it", () => {
  const note = assistantNoteFor({ ...assistant, askBeforeActing: true }, "hi");
  assert.ok(note.includes("held until the user approves it"));
  assert.ok(note.includes("tell the user it is waiting and stop"));
  assert.ok(!assistantNoteFor(assistant, "hi").includes("Ask before acting"));
});

it("lists each group's teammates with their roles and names the lead only as the router", () => {
  const ray = { name: "Ray", handle: "ray", threadId: "assistant:ray:1" as never };
  const lee = { name: "Lee", handle: "lee", threadId: "assistant:lee:1" as never, role: "Dev" };
  const team = { name: 'Core "A"' };
  const asMember = assistantNoteFor(assistant, "hi", [{ team, lead: ray, teammates: [ray, lee] }]);
  assert.ok(
    asMember.includes(
      'Group "Core "A"": Ray (@ray, threadId assistant:ray:1); Lee (@lee, threadId assistant:lee:1), Dev.',
    ),
  );
  assert.ok(asMember.includes("Ray routes group requests that mention no one."));
  assert.ok(asMember.includes("send, then end your turn"));
  assert.ok(asMember.includes("never reply to a reply"));
  const asLead = assistantNoteFor(assistant, "hi", [
    { team, lead: { ...ray, handle: "sam" }, teammates: [lee] },
  ]);
  assert.ok(asLead.includes("You route group requests that mention no one."));
  const noLead = assistantNoteFor(assistant, "hi", [{ team, lead: null, teammates: [lee] }]);
  assert.ok(!noLead.includes("route"));
  assert.ok(!assistantNoteFor(assistant, "hi").includes("Group "));
});

it("tells a sandboxed assistant where its work runs, or that the sandbox is not linked yet", () => {
  const boxed = { ...assistant, workspace: "sandbox" } as const;
  const linked = assistantNoteFor(boxed, "hi", [], "environment-sandbox");
  assert.ok(linked.includes("environmentId environment-sandbox"));
  assert.ok(linked.includes("On this Mac you only read"));
  assert.ok(linked.includes(`access="read-only" sandbox_access="${assistant.toolAccess}"`));
  assert.ok(assistantNoteFor(boxed, "hi").includes("not linked yet"));
  assert.ok(!assistantNoteFor(assistant, "hi", [], "environment-sandbox").includes("sandbox"));
});
