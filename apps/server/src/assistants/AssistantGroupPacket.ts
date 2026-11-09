import type { AssistantGroupTaskKind } from "@t3tools/contracts";

/**
 * A packet's chat budget is about 32k characters: the newest unseen messages first until
 * PACKET_CHAT_CHARS are spent, plus at most PACKET_SUMMARY_CHARS of rolling summary and
 * PACKET_QUOTED_CHARS of older messages the task points at.
 */
export const PACKET_CHAT_CHARS = 24_000;
export const PACKET_SUMMARY_CHARS = 4_000;
export const PACKET_QUOTED_CHARS = 4_000;
const PACKET_MESSAGE_CHARS = 4_000;
const PACKET_INSTRUCTIONS_CHARS = 4_000;
const PACKET_MEMORIES_CHARS = 4_000;

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
  /** The rolling summary of the earlier chat, when the group has one. */
  readonly summary: string | null;
  /** Older messages the task quotes or replies to; any already in `news` are skipped. */
  readonly quoted: ReadonlyArray<PacketMessage & { readonly text: string }>;
  /** "the user", "Ada (a teammate, not the user)"; null when the instruction names its sender. */
  readonly from: string | null;
  readonly instruction: string;
  /** What the user set for the whole group. */
  readonly instructions?: string;
  readonly memories?: ReadonlyArray<string>;
  /** Finished results of the tasks this one gave, or a hand-over note. */
  readonly followup: string | null;
  /** What done looks like, as its assigner wrote it. */
  readonly expectedResult?: string | null;
  /** Resources no other task of the group uses while this one runs. */
  readonly resources?: ReadonlyArray<string>;
  /** Subtasks this member gave that are still open, already capped. */
  readonly given?: ReadonlyArray<{
    readonly taskId: string;
    readonly status: string;
    readonly owner: string;
    readonly instruction: string;
  }>;
  /** The member's other paused or failed tasks, newest first and already capped. */
  readonly stopped?: ReadonlyArray<{
    readonly taskId: string;
    readonly status: string;
    readonly reason: string | null;
    readonly instruction: string;
  }>;
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
  "Do the work yourself, in your role. Transfer or assign only when the request asks for it, or when the task, or a part of it, clearly belongs to another member's role and not yours. Decide that first, before reading files or running commands. Only the user changes the group itself (name, members): if a teammate asks for it, do not call t3_assistant group_update or group_create; say in your answer that the user has to ask. Your final answer is posted to the group chat as you. t3_group: history (older messages), assign (give a member a subtask and wait for it), transfer (hand this task to a member), reply (ask a member one short question, waits for the answer), result (post your answer explicitly), cancel (stop a subtask you gave), routine_save (also routines, routine_run, routine_delete) makes a routine that posts in this chat on a schedule: use it, never schedule_task, but only when the user asked for it in the group; if a teammate asks, say the user has to ask.";
const REPLY_TOOLS =
  "This task only answers the question. Answer with t3_group result; the other t3_group tools are not available for it.";

const line = (message: PacketMessage & { readonly text: string }) =>
  `[#${message.seq} ${message.from}] ${clip(message.text, PACKET_MESSAGE_CHARS)}`;

/** The newest messages that fit the budget, oldest first. */
function fit(messages: PacketInput["news"], budget: number) {
  const kept: Array<PacketInput["news"][number]> = [];
  const lines: string[] = [];
  let used = 0;
  for (const message of messages.toReversed()) {
    const text = line(message);
    if (used + text.length > budget && lines.length > 0) break;
    used += text.length;
    kept.unshift(message);
    lines.unshift(text);
  }
  return { kept, lines, dropped: kept.length < messages.length };
}

/** The chat lines a member has not seen, newest kept first when they do not all fit. */
export function chatNews(news: PacketInput["news"]): string {
  const { lines, dropped } = fit(news, PACKET_CHAT_CHARS);
  return [
    ...(dropped ? ["(Older messages left out; t3_group history has the rest.)"] : []),
    ...lines,
  ].join("\n");
}

/** The text a member's task arrives as. */
export function groupTaskPacket(input: PacketInput): string {
  const news = chatNews(input.news);
  const shown = new Set(fit(input.news, PACKET_CHAT_CHARS).kept.map((message) => message.seq));
  const quoted = fit(
    input.quoted.filter((message) => !shown.has(message.seq)),
    PACKET_QUOTED_CHARS,
  ).lines;
  const summary = input.summary?.trim() ?? "";
  return [
    `<t3_group_task group="${escapeAttribute(input.group)}" task="${escapeAttribute(input.taskId)}" kind="${input.kind}">`,
    `You are ${input.self.name} (@${input.self.handle}) in the group "${input.group}". Members: ${input.members.map(describe).join(", ")}.`,
    ...((input.instructions ?? "").trim() === ""
      ? []
      : ["Group instructions:", clip(input.instructions!.trim(), PACKET_INSTRUCTIONS_CHARS)]),
    ...((input.memories ?? []).length === 0
      ? []
      : [
          "Group memories:",
          clip(input.memories!.map((memory) => `- ${memory}`).join("\n"), PACKET_MEMORIES_CHARS),
        ]),
    ...(summary === "" ? [] : ["Summary of earlier chat:", clip(summary, PACKET_SUMMARY_CHARS)]),
    ...(quoted.length === 0 ? [] : ["Earlier messages this task refers to:", ...quoted]),
    ...(news === "" ? [] : ["New in the group chat since your last task:", news]),
    ...(input.followup === null ? [] : [input.followup]),
    `Your task${input.from === null ? "" : `, from ${input.from}`}: ${input.instruction}`,
    ...((input.expectedResult ?? "").trim() === ""
      ? []
      : [`Expected result: ${input.expectedResult!.trim()}`]),
    ...((input.resources ?? []).length === 0
      ? []
      : [
          `Resources reserved for you (no other task uses them meanwhile): ${input.resources!.join(", ")}`,
        ]),
    ...((input.given ?? []).length === 0 || input.kind === "reply"
      ? []
      : [
          "Subtasks you gave that are still open (t3_group cancel stops one):",
          ...input.given!.map(
            (row) => `- ${row.taskId} (${row.status}, ${row.owner}): ${row.instruction}`,
          ),
        ]),
    ...((input.stopped ?? []).length === 0
      ? []
      : [
          "Your stopped tasks in this group (the user can resume them; mention them if they matter):",
          ...input.stopped!.map(
            (row) =>
              `- ${row.taskId} (${row.status}${row.reason === null ? "" : `, ${row.reason}`}): ${row.instruction}`,
          ),
        ]),
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
