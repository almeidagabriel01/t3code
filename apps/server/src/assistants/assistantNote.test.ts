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

it("tells an assistant that must ask before acting to wait and not route around it", () => {
  const note = assistantNoteFor({ ...assistant, askBeforeActing: true }, "hi");
  assert.ok(note.includes("held until the user approves it"));
  assert.ok(note.includes("tell the user it is waiting and stop"));
  assert.ok(!assistantNoteFor(assistant, "hi").includes("Ask before acting"));
});

it("lists each team with its teammates and tells the leader and the members what to do", () => {
  const ray = { name: "Ray", handle: "ray", threadId: "assistant:ray:1" as never };
  const lee = { name: "Lee", handle: "lee", threadId: "assistant:lee:1" as never, role: "Dev" };
  const team = { name: 'Core "A"', leaderTitle: "Head of Research" };
  const asMember = assistantNoteFor(assistant, "hi", undefined, [
    { team, leader: ray, teammates: [ray, lee] },
  ]);
  assert.ok(
    asMember.includes(
      'Team "Core "A"": Ray (@ray, threadId assistant:ray:1); Lee (@lee, threadId assistant:lee:1), Dev.',
    ),
  );
  assert.ok(asMember.includes("Ray is the team's Head of Research: report your results to them"));
  assert.ok(asMember.includes("never reply just to acknowledge"));
  const asLeader = assistantNoteFor(assistant, "hi", undefined, [
    { team: { name: "T", leaderTitle: null }, leader: { ...ray, handle: "sam" }, teammates: [lee] },
  ]);
  assert.ok(asLeader.includes("You are the team's leader: coordinate"));
  const noLeader = assistantNoteFor({ ...assistant, handle: "sam" }, "hi", undefined, [
    { team: { name: "T", leaderTitle: null }, leader: null, teammates: [lee] },
  ]);
  assert.ok(!noLeader.includes("team's"));
  assert.ok(!assistantNoteFor(assistant, "hi").includes("Team "));
});

it("tells a sandboxed assistant where its work runs, or that the sandbox is not linked yet", () => {
  const boxed = { ...assistant, workspace: "sandbox" } as const;
  const linked = assistantNoteFor(boxed, "hi", undefined, [], "environment-sandbox");
  assert.ok(linked.includes("environmentId environment-sandbox"));
  assert.ok(linked.includes("On this Mac you only read"));
  assert.ok(assistantNoteFor(boxed, "hi").includes("not linked yet"));
  assert.ok(
    !assistantNoteFor(assistant, "hi", undefined, [], "environment-sandbox").includes("sandbox"),
  );
});
