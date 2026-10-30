import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import type { RuntimeMode } from "./providerPolicy.ts";

/**
 * An assistant is a named, long-lived conversation: a row that points at its current real thread.
 * The thread's own model selection is the assistant's model; a reset starts a new generation.
 */
export const ASSISTANT_NAME_MAX_LENGTH = 60;
export const ASSISTANT_INSTRUCTIONS_MAX_CHARS = 8_000;
export const DEFAULT_ASSISTANT_ID = "jarvis";

export const AssistantId = TrimmedNonEmptyString.pipe(Schema.brand("AssistantId"));
export type AssistantId = typeof AssistantId.Type;

/** Lowercase slug, unique per environment; channels route `@handle` to it. */
export const AssistantHandle = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/),
);
export type AssistantHandle = typeof AssistantHandle.Type;

/** A slug for `name`, or null when nothing usable remains. */
export function assistantHandleFromName(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug.length === 0 ? null : slug;
}

/** Enforced through the thread's runtime mode and, for read-only, a read-only sandbox. */
export const AssistantToolAccess = Schema.Literals(["read-only", "workspace-write", "full"]);
export type AssistantToolAccess = typeof AssistantToolAccess.Type;

export function runtimeModeForToolAccess(access: AssistantToolAccess): RuntimeMode {
  switch (access) {
    case "read-only":
      return "approval-required";
    case "workspace-write":
      return "auto-accept-edits";
    case "full":
      return "full-access";
  }
}

export const ASSISTANT_THREAD_PREFIX = "assistant:";

export function isAssistantThreadId(threadId: string): boolean {
  return threadId.startsWith(ASSISTANT_THREAD_PREFIX);
}

export function assistantThreadIdFor(assistantId: string, generation: number): ThreadId {
  return ThreadId.make(`${ASSISTANT_THREAD_PREFIX}${assistantId}:${generation}`);
}

/** The assistant id inside an assistant thread id, or null for any other thread. */
export function assistantIdFromThreadId(threadId: string): string | null {
  if (!isAssistantThreadId(threadId)) return null;
  const rest = threadId.slice(ASSISTANT_THREAD_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  return cut <= 0 ? null : rest.slice(0, cut);
}

export const Assistant = Schema.Struct({
  id: AssistantId,
  handle: AssistantHandle,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_NAME_MAX_LENGTH)),
  projectId: ProjectId,
  instructions: Schema.String.check(Schema.isMaxLength(ASSISTANT_INSTRUCTIONS_MAX_CHARS)),
  toolAccess: AssistantToolAccess,
  /** Jarvis; it always exists and can't be archived or deleted. */
  isDefault: Schema.Boolean,
  /** The current conversation; null only until its first launch lands. */
  threadId: Schema.NullOr(ThreadId),
  generation: Schema.Number,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Assistant = typeof Assistant.Type;

export const AssistantsSubscribeInput = Schema.Struct({});
export type AssistantsSubscribeInput = typeof AssistantsSubscribeInput.Type;

/** The first event is a snapshot of every assistant, archived ones included. */
export const AssistantsEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), assistants: Schema.Array(Assistant) }),
  Schema.Struct({ type: Schema.Literal("upserted"), assistant: Assistant }),
  Schema.Struct({ type: Schema.Literal("removed"), assistantId: AssistantId }),
]);
export type AssistantsEvent = typeof AssistantsEvent.Type;

export const AssistantsCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_NAME_MAX_LENGTH)),
  /** Derived from the name when absent. */
  handle: Schema.optional(AssistantHandle),
  projectId: ProjectId,
  /** The default new-thread model when absent. */
  modelSelection: Schema.optional(ModelSelection),
  instructions: Schema.String.check(Schema.isMaxLength(ASSISTANT_INSTRUCTIONS_MAX_CHARS)),
  toolAccess: AssistantToolAccess,
});
export type AssistantsCreateInput = typeof AssistantsCreateInput.Type;

/** Changing `projectId` starts a new generation: a thread can't move between projects. */
export const AssistantsUpdateInput = Schema.Struct({
  assistantId: AssistantId,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_NAME_MAX_LENGTH))),
  handle: Schema.optional(AssistantHandle),
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_INSTRUCTIONS_MAX_CHARS)),
  ),
  toolAccess: Schema.optional(AssistantToolAccess),
  archived: Schema.optional(Schema.Boolean),
});
export type AssistantsUpdateInput = typeof AssistantsUpdateInput.Type;

export const AssistantsDeleteInput = Schema.Struct({ assistantId: AssistantId });
export type AssistantsDeleteInput = typeof AssistantsDeleteInput.Type;

/** A fresh conversation, or `restoreThreadId` to bring back one of this assistant's old ones. */
export const AssistantsResetInput = Schema.Struct({
  assistantId: AssistantId,
  restoreThreadId: Schema.optional(ThreadId),
});
export type AssistantsResetInput = typeof AssistantsResetInput.Type;

export const AssistantsDeleteResult = Schema.Struct({ assistantId: AssistantId });
export type AssistantsDeleteResult = typeof AssistantsDeleteResult.Type;

export class AssistantError extends Schema.TaggedError<AssistantError>()("AssistantError", {
  reason: Schema.Literals(["not_found", "handle_taken", "default_protected", "invalid", "storage"]),
  message: Schema.String,
}) {}
