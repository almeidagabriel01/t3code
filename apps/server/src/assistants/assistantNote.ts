import type { Assistant, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AssistantDirectoryShape } from "./AssistantDirectory.ts";

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Never closes the block early, whatever the user typed into the instructions. */
const escapeBody = (value: string) => value.replace(/<\/t3_assistant/gi, "<\\/t3_assistant");

type Colleague = Pick<Assistant, "name" | "handle" | "threadId">;

const colleague = (other: Colleague) =>
  `${other.name} (@${other.handle}, threadId ${other.threadId ?? "none yet"})`;

/** One line the model can act on: who to ask, who it answers to. Empty without an org relation. */
function teamLine(leader: Colleague | null, reports: ReadonlyArray<Colleague>): string {
  const parts = [
    leader === null
      ? ""
      : `You report to ${colleague(leader)}; answer them through your run result, never by messaging them.`,
    reports.length === 0 ? "" : `Your direct reports: ${reports.map(colleague).join("; ")}.`,
  ].filter((part) => part !== "");
  return escapeBody(parts.join(" "));
}

const ASK_BEFORE_ACTING_LINE =
  "Ask before acting is on: a message you send into another agent conversation is held until the user approves it in this conversation. If a send says it is waiting for approval, tell the user it is waiting and stop; send the same message again only after they approve, and never send it another way if they decline.";

export function assistantNoteFor(
  assistant: Pick<Assistant, "name" | "handle" | "toolAccess" | "instructions" | "role"> & {
    readonly askBeforeActing?: boolean | undefined;
  },
  userText: string,
  team: { readonly leader: Colleague | null; readonly reports: ReadonlyArray<Colleague> } = {
    leader: null,
    reports: [],
  },
): string {
  // Provider-native slash commands must stay at the start of the prompt.
  if (userText.trimStart().startsWith("/")) return "";
  const role = assistant.role === "" ? "" : ` role="${escapeAttribute(assistant.role)}"`;
  const open = `<t3_assistant name="${escapeAttribute(assistant.name)}" handle="${assistant.handle}"${role} access="${assistant.toolAccess}">`;
  const body = [
    teamLine(team.leader, team.reports),
    assistant.askBeforeActing === true ? ASK_BEFORE_ACTING_LINE : "",
    escapeBody(assistant.instructions.trim()),
  ]
    .filter((part) => part !== "")
    .join("\n");
  return body === "" ? `${open}\n</t3_assistant>` : `${open}\n${body}\n</t3_assistant>`;
}

/**
 * Sent ahead of every turn of an assistant thread, not once: the instructions then survive
 * compaction, native resume and a provider switch, and an edit applies from the next turn.
 */
export const assistantNote = Effect.fn("AssistantNote.forTurn")(function* (
  directory: Option.Option<AssistantDirectoryShape>,
  threadId: ThreadId,
  userText: string,
) {
  if (Option.isNone(directory)) return "";
  const found = yield* directory.value.forThread(threadId);
  if (Option.isNone(found)) return "";
  const { assistant } = found.value;
  const team = userText.trimStart().startsWith("/")
    ? undefined
    : yield* directory.value.teamOf(assistant);
  return assistantNoteFor(assistant, userText, team);
});
