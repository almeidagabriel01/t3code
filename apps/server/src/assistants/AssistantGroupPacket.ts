import type { AssistantGroupTaskKind } from "@t3tools/contracts";

/** Newest chat messages first until this many characters are spent. */
export const PACKET_CHAT_CHARS = 12_000;
const PACKET_MESSAGE_CHARS = 4_000;

export interface PacketMember {
  readonly name: string;
  readonly handle: string;
  readonly role: string;
  readonly isLead: boolean;
}

export interface PacketMessage {
  readonly seq: number;
  /** Who wrote it: "user", a member's name, or an agent or schedule label. */
  readonly from: string;
}

export interface PacketInput {
  readonly group: string;
  readonly taskId: string;
  readonly kind: AssistantGroupTaskKind;
  readonly self: PacketMember;
  readonly members: ReadonlyArray<PacketMember>;
  /** Oldest first. */
  readonly news: ReadonlyArray<PacketMessage & { readonly text: string }>;
  /** "the user", "Ada (a teammate, not the user)"; null when the instruction names its sender. */
  readonly from: string | null;
  readonly instruction: string;
  /** Finished results of the tasks this one gave, or a hand-over note. */
  readonly followup: string | null;
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const clip = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
};

const describe = (member: PacketMember) =>
  `${member.name} (@${member.handle}${member.role === "" ? "" : `, ${member.role}`}${member.isLead ? ", lead" : ""})`;

const TOOLS =
  "Your final answer is posted to the group chat as you. t3_group: history (older messages), assign (give a member a subtask and wait for it), transfer (hand this task to a member), reply (ask a member one short question, waits for the answer), result (post your answer explicitly).";
const REPLY_TOOLS =
  "This task only answers the question. Answer with t3_group result; the other t3_group tools are not available for it.";

/** The chat lines a member has not seen, newest kept first when they do not all fit. */
export function chatNews(news: PacketInput["news"]): string {
  const lines: string[] = [];
  let used = 0;
  let dropped = false;
  for (const message of news.toReversed()) {
    const line = `[#${message.seq} ${message.from}] ${clip(message.text, PACKET_MESSAGE_CHARS)}`;
    if (used + line.length > PACKET_CHAT_CHARS && lines.length > 0) {
      dropped = true;
      break;
    }
    used += line.length;
    lines.unshift(line);
  }
  return [
    ...(dropped ? ["(Older messages left out; t3_group history has the rest.)"] : []),
    ...lines,
  ].join("\n");
}

/** The text a member's task arrives as. */
export function groupTaskPacket(input: PacketInput): string {
  const news = chatNews(input.news);
  return [
    `<t3_group_task group="${escapeAttribute(input.group)}" task="${escapeAttribute(input.taskId)}" kind="${input.kind}">`,
    `You are ${input.self.name} (@${input.self.handle}) in the group "${input.group}". Members: ${input.members.map(describe).join(", ")}.`,
    ...(news === "" ? [] : ["New in the group chat since your last task:", news]),
    ...(input.followup === null ? [] : [input.followup]),
    `Your task${input.from === null ? "" : `, from ${input.from}`}: ${input.instruction}`,
    input.kind === "reply" ? REPLY_TOOLS : TOOLS,
    "</t3_group_task>",
  ].join("\n");
}

/** What a task that waited on others reads when they are all done. */
export function childResultsText(
  results: ReadonlyArray<{
    readonly owner: string;
    readonly status: string;
    readonly text: string;
  }>,
): string {
  return [
    "The tasks you gave are finished:",
    ...results.map(
      (result) =>
        `- ${result.owner} (${result.status}): ${clip(result.text, 2_000) || "(no answer)"}`,
    ),
  ].join("\n");
}

export const handOverText = (from: string, note: string) =>
  `${from} (a teammate, not the user) handed this task to you${note.trim() === "" ? "." : `: ${note.trim()}`}`;
