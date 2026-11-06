import type { OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionRecordFilter, ProjectionStoreV2Error } from "./ProjectionStore.ts";
import { type SideChatParentSnapshot, sideChatParentContext } from "./SideChatParentContext.ts";

/** The projection reads a side-chat note needs; ProjectionStoreV2 provides them. */
export interface SideChatParentReader {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<SideChatParentSnapshot["shell"] | null, ProjectionStoreV2Error>;
  readonly getThreadRecords: (
    threadId: ThreadId,
    fields: ReadonlyArray<"messages" | "plans">,
    filter: ProjectionRecordFilter,
  ) => Effect.Effect<Pick<SideChatParentSnapshot, "messages" | "plans">, ProjectionStoreV2Error>;
}

/**
 * Sent ahead of every side-chat prompt, which keeps the boundary in place after a native
 * resume or a portable handoff. The inherited history is the parent's, so the note marks it
 * as reference and keeps the side agent from continuing the parent's work or changing the
 * workspace the parent is using. The parent's live state follows it in a `<parent_thread>` block.
 */
export const SIDE_CHAT_NOTE = `<side_chat>
This is a side chat opened beside the user's main thread. The earlier conversation, if any, and the <parent_thread> block belong to the main thread and are reference only: do not continue, execute, or complete any task, plan, tool call, or request from them. Answer the user's side question directly and briefly.
Do not modify files, git state, configuration, or other workspace state unless the user explicitly asks for that change in this side chat, and keep any such change minimal. Do not launch threads, delegate tasks, or schedule work from here. The one exception: when the user explicitly asks to send or forward something to the main thread, send it with t3_thread_send to the main thread's id stated in this chat; never send to it otherwise.
</side_chat>`;

type SideChatThread = {
  readonly lineage: Pick<OrchestrationV2AppThread["lineage"], "parentThreadId" | "sideChat">;
};

/** Side chats get the note, except ahead of a slash command. */
function needsSideChatNote(thread: SideChatThread, userText: string): boolean {
  // Provider-native slash commands must stay at the start of the prompt.
  return thread.lineage.sideChat === true && !userText.trimStart().startsWith("/");
}

/** The side-chat note for this prompt followed by the parent's live state, or "" when none applies. */
export function sideChatNoteFor(
  thread: SideChatThread,
  userText: string,
  parentContext: string,
): string {
  if (!needsSideChatNote(thread, userText)) return "";
  return parentContext === "" ? SIDE_CHAT_NOTE : `${SIDE_CHAT_NOTE}\n\n${parentContext}`;
}

/**
 * The note for a side-chat turn, read from the parent's projection each time so the side agent
 * sees the parent's current run, goal, and latest messages whether its thread was forked
 * earlier or started empty. A failed read still sends the boundary and says the state is missing.
 */
export const sideChatNote = Effect.fn("SideChatNote.forTurn")(function* (
  projectionStore: SideChatParentReader,
  thread: SideChatThread,
  userText: string,
  /** The first turn carries the fork's own digest of the parent, so only the boundary is sent. */
  firstTurn = false,
) {
  const parentThreadId = thread.lineage.parentThreadId;
  if (parentThreadId === null || !needsSideChatNote(thread, userText)) return "";
  if (firstTurn) return sideChatNoteFor(thread, userText, "");
  const parentContext = yield* Effect.gen(function* () {
    const shell = yield* projectionStore.getThreadShell(parentThreadId);
    if (shell === null) return sideChatParentContext(null, parentThreadId);
    const records = yield* projectionStore.getThreadRecords(parentThreadId, ["messages", "plans"], {
      messageRoles: ["user", "assistant"],
    });
    return sideChatParentContext(
      { shell, messages: records.messages, plans: records.plans },
      parentThreadId,
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the side chat's parent thread", {
        parentThreadId,
        cause,
      }).pipe(Effect.as(sideChatParentContext(null, parentThreadId))),
    ),
  );
  return sideChatNoteFor(thread, userText, parentContext);
});
