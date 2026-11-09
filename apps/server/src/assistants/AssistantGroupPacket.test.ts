import { assert, it } from "@effect/vitest";

import {
  PACKET_CHAT_CHARS,
  PACKET_QUOTED_CHARS,
  PACKET_SUMMARY_CHARS,
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
  summary: null,
  quoted: [],
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
  const news = Array.from({ length: 10 }, (_, index) => ({
    seq: index + 1,
    from: "user",
    text: `${index + 1}`.repeat(3_900),
  }));
  const lines = chatNews(news).split("\n");
  assert.include(lines[0], "Older messages left out");
  assert.isTrue(lines.at(-1)!.startsWith("[#10 user]"));
  assert.isAtMost(lines.slice(1).join("\n").length, PACKET_CHAT_CHARS + 100);
  assert.strictEqual(
    chatNews([{ seq: 1, from: "Beto", text: "x".repeat(5_000) }]).length < 4_100,
    true,
  );
  assert.strictEqual(chatNews([]), "");
  assert.include(childResultsText([{ owner: "Cy", status: "failed", text: "" }]), "(no answer)");
});

it("puts the summary first, cut to its budget, and older quoted messages before the news", () => {
  const packet = groupTaskPacket({
    ...base,
    summary: `  ${"s".repeat(PACKET_SUMMARY_CHARS + 500)}  `,
    news: [{ seq: 9, from: "user", text: "latest" }],
    quoted: [
      { seq: 2, from: "Beto", text: "the budget is 5k" },
      { seq: 9, from: "user", text: "latest" },
    ],
  });
  const at = (text: string) => packet.indexOf(text);
  assert.isBelow(at("Summary of earlier chat:"), at("Earlier messages this task refers to:"));
  assert.isBelow(at("Earlier messages this task refers to:"), at("New in the group chat"));
  assert.include(packet, "[#2 Beto] the budget is 5k");
  // A quoted message already in the news is not shown twice.
  assert.strictEqual(packet.split("[#9 user] latest").length, 2);
  assert.isBelow(packet.length, PACKET_SUMMARY_CHARS + 1_500);
  assert.notInclude(groupTaskPacket({ ...base, summary: "   " }), "Summary of earlier chat");
  assert.notInclude(groupTaskPacket(base), "Earlier messages this task");
});

it("quoted messages are kept newest first within their own budget", () => {
  const quoted = Array.from({ length: 4 }, (_, index) => ({
    seq: index + 1,
    from: "Cy",
    text: `${index + 1}`.repeat(2_500),
  }));
  const packet = groupTaskPacket({ ...base, quoted });
  assert.include(packet, "[#4 Cy]");
  assert.notInclude(packet, "[#1 Cy]");
  assert.isAtMost(packet.split("[#").slice(1).join("[#").length, PACKET_QUOTED_CHARS + 600);
});

it("clips the group's instructions and memories, and leaves blank ones out", () => {
  const packet = groupTaskPacket({
    ...base,
    instructions: `  Be brief. ${"x".repeat(5_000)}`,
    memories: ["Budget is 5k", "m".repeat(5_000)],
  });
  assert.include(packet, "Group instructions:\nBe brief. xxx");
  assert.isBelow(packet.indexOf("Group memories:"), packet.indexOf("Your task"));
  assert.include(packet, "Group memories:\n- Budget is 5k\n- mmm");
  assert.isBelow(packet.length, 12_000);
  const blank = groupTaskPacket({ ...base, instructions: "  ", memories: [] });
  assert.notInclude(blank, "Group instructions:");
  assert.notInclude(blank, "Group memories:");
});
