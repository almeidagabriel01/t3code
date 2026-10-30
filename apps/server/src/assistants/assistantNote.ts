import type { Assistant, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AssistantDirectoryShape } from "./AssistantDirectory.ts";

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Never closes the block early, whatever the user typed into the instructions. */
const escapeBody = (value: string) => value.replace(/<\/t3_assistant/gi, "<\\/t3_assistant");

export function assistantNoteFor(
  assistant: Pick<Assistant, "name" | "handle" | "toolAccess" | "instructions">,
  userText: string,
): string {
  // Provider-native slash commands must stay at the start of the prompt.
  if (userText.trimStart().startsWith("/")) return "";
  const open = `<t3_assistant name="${escapeAttribute(assistant.name)}" handle="${assistant.handle}" access="${assistant.toolAccess}">`;
  const instructions = assistant.instructions.trim();
  return instructions === ""
    ? `${open}\n</t3_assistant>`
    : `${open}\n${escapeBody(instructions)}\n</t3_assistant>`;
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
  return Option.isNone(found) ? "" : assistantNoteFor(found.value.assistant, userText);
});
