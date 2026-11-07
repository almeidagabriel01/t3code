import { assert, it } from "@effect/vitest";

import {
  PACKET_CHAT_CHARS,
  chatNews,
  childResultsText,
  groupTaskPacket,
  handOverText,
  type PacketInput,
} from "./AssistantGroupPacket.ts";

const ada = { name: "Ada", handle: "ada", role: "CFO", isLead: false };
const beto = { name: "Beto", handle: "beto", role: "", isLead: true };
const base: PacketInput = {
  group: 'Money "Team"',
  taskId: "gt:1",
  kind: "root",
  self: ada,
  members: [ada, beto],
  news: [],
  from: "the user",
  instruction: "Close the books",
  followup: null,
};

it("names the group, the members and the task, and escapes the group in the tag", () => {
  const packet = groupTaskPacket(base);
  assert.include(packet, '<t3_group_task group="Money &quot;Team&quot;" task="gt:1" kind="root">');
  assert.include(
    packet,
    'You are Ada (@ada) in the group "Money "Team"". Members: Ada (@ada, CFO), Beto (@beto, lead).',
  );
  assert.include(packet, "Your task, from the user: Close the books");
  assert.include(packet, "t3_group: history");
  assert.notInclude(packet, "New in the group chat");
  assert.isTrue(packet.endsWith("</t3_group_task>"));
});

it.each([
  ["a task whose instruction names its sender", { ...base, from: null }, "Your task: Close"],
  [
    "a reply, which may only answer",
    { ...base, kind: "reply" as const },
    "only answers the question",
  ],
  [
    "a resumed parent",
    { ...base, followup: childResultsText([{ owner: "Beto", status: "completed", text: "done" }]) },
    "- Beto (completed): done",
  ],
  [
    "a transfer",
    { ...base, followup: handOverText("Ada", " check Q3 ") },
    "Ada (a teammate, not the user) handed this task to you: check Q3",
  ],
  [
    "a transfer with no note",
    { ...base, followup: handOverText("Ada", "") },
    "handed this task to you.",
  ],
] as const)("%s", (_name, input, expected) => {
  assert.include(groupTaskPacket(input), expected);
});

it("keeps the newest chat lines when they do not all fit and says what was left out", () => {
  const news = Array.from({ length: 6 }, (_, index) => ({
    seq: index + 1,
    from: "user",
    text: `${index + 1}`.repeat(3_900),
  }));
  const lines = chatNews(news).split("\n");
  assert.include(lines[0], "Older messages left out");
  assert.isTrue(lines.at(-1)!.startsWith("[#6 user]"));
  assert.isAtMost(lines.slice(1).join("\n").length, PACKET_CHAT_CHARS + 100);
  assert.strictEqual(
    chatNews([{ seq: 1, from: "Beto", text: "x".repeat(5_000) }]).length < 4_100,
    true,
  );
  assert.strictEqual(chatNews([]), "");
  assert.include(childResultsText([{ owner: "Cy", status: "failed", text: "" }]), "(no answer)");
});
