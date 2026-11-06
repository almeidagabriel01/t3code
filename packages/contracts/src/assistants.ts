import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { AssistantAutonomy, DEFAULT_ASSISTANT_AUTONOMY } from "./autonomy.ts";
import { ModelSelection } from "./modelSelection.ts";
import type { RuntimeMode } from "./providerPolicy.ts";
import { InstanceBudgetStatus, ProviderBudget } from "./usage.ts";

/**
 * An assistant is a named, long-lived conversation: a row that points at its current real thread.
 * The thread's own model selection is the assistant's model; a reset starts a new generation.
 */
export const ASSISTANT_NAME_MAX_LENGTH = 60;
export const ASSISTANT_ROLE_MAX_LENGTH = 60;
export const ASSISTANT_INSTRUCTIONS_MAX_CHARS = 8_000;
export const DEFAULT_ASSISTANT_ID = "jarvis";

export const AssistantId = TrimmedNonEmptyString.pipe(Schema.brand("AssistantId"));
export type AssistantId = typeof AssistantId.Type;

const AssistantRole = TrimmedString.check(Schema.isMaxLength(ASSISTANT_ROLE_MAX_LENGTH));

/** `id` and everyone below it in the reports-to tree; a cycle in bad data still ends. */
export function assistantDescendantIds(
  assistants: ReadonlyArray<{ readonly id: string; readonly reportsTo: string | null }>,
  id: string,
): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (found.has(next)) continue;
    found.add(next);
    for (const assistant of assistants) if (assistant.reportsTo === next) queue.push(assistant.id);
  }
  return found;
}

/** The standup task is recognised by this opening line, so a rename of its title is harmless. */
export const ASSISTANT_STANDUP_PROMPT_HEAD = "Daily team standup.";
export const ASSISTANT_STANDUP_TASK_TITLE = "Daily standup";
export const ASSISTANT_STANDUP_PROMPT = [
  ASSISTANT_STANDUP_PROMPT_HEAD,
  "Ask each of your direct reports (see your team note) for a short status: t3_thread_send to its threadId, then t3_thread_wait on the run it returns.",
  "Then write one short report for the user: what each report did, what is blocked, and what needs the user. Skip a report that did not answer and say so.",
].join("\n");

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

/**
 * Chat command names (`/name`, `[a-z0-9_]{1,32}`) for each assistant, from its handle, in list
 * order; a name another assistant already took gets `_2`, `_3`, ….
 */
export function assistantCommandNames<A extends { readonly handle: string }>(
  assistants: ReadonlyArray<A>,
): ReadonlyArray<{ readonly command: string; readonly assistant: A }> {
  const taken = new Set<string>();
  return assistants.map((assistant) => {
    const base =
      assistant.handle
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 32) || "assistant";
    let command = base;
    for (let n = 2; taken.has(command); n += 1) {
      const suffix = `_${n}`;
      command = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    }
    taken.add(command);
    return { command, assistant };
  });
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
  /** Jarvis: made on first use, then archived, deleted and restored like any other. */
  isDefault: Schema.Boolean,
  /** The current conversation; null only until its first launch lands. */
  threadId: Schema.NullOr(ThreadId),
  generation: Schema.Number,
  /** Spending cap over every conversation it had; priced like provider budgets. */
  budget: Schema.NullOr(ProviderBudget).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Free text such as "CEO" or "Engineer"; empty when it has none. */
  role: AssistantRole.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** The leader it answers to; null for a top-level assistant. */
  reportsTo: Schema.NullOr(AssistantId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Whether and how it wakes on its own; see `autonomy.ts`. */
  autonomy: AssistantAutonomy.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ASSISTANT_AUTONOMY)),
  ),
  /** It may not send into an agent conversation until the user approves that exact send. */
  askBeforeActing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
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
  budget: Schema.optional(Schema.NullOr(ProviderBudget)),
  autonomy: Schema.optional(AssistantAutonomy),
  askBeforeActing: Schema.optional(Schema.Boolean),
  role: Schema.optional(AssistantRole),
  reportsTo: Schema.optional(Schema.NullOr(AssistantId)),
  /** Brings Jarvis back (recreated or unarchived) and ignores every other field. */
  restoreDefault: Schema.optional(Schema.Boolean),
});
export type AssistantsCreateInput = typeof AssistantsCreateInput.Type;

/** The other fields are placeholders: the server only reads `restoreDefault`. */
export const ASSISTANTS_RESTORE_DEFAULT_INPUT: AssistantsCreateInput = {
  name: TrimmedNonEmptyString.make("Jarvis"),
  projectId: ProjectId.make("restore-default"),
  instructions: "",
  toolAccess: "full",
  restoreDefault: true,
};

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
  /** Null removes the cap. */
  budget: Schema.optional(Schema.NullOr(ProviderBudget)),
  autonomy: Schema.optional(AssistantAutonomy),
  askBeforeActing: Schema.optional(Schema.Boolean),
  role: Schema.optional(AssistantRole),
  /** Null makes it top-level. */
  reportsTo: Schema.optional(Schema.NullOr(AssistantId)),
  /** Adds the daily standup schedule once; it stays an ordinary scheduled task afterwards. */
  addStandup: Schema.optional(Schema.Literal(true)),
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

export const AssistantsSpendInput = Schema.Struct({ assistantId: AssistantId });
export type AssistantsSpendInput = typeof AssistantsSpendInput.Type;

/** Estimated at API prices from T3's own turns, across every conversation the assistant had. */
export const AssistantSpend = Schema.Struct({
  todayUsd: Schema.Number,
  /** Rolling last 30 days, including today. */
  periodUsd: Schema.Number,
  /** Some turns had no usage or no known rate, so the totals are a floor. */
  partial: Schema.Boolean,
  budget: Schema.optionalKey(InstanceBudgetStatus),
});
export type AssistantSpend = typeof AssistantSpend.Type;

export const AssistantsDeleteResult = Schema.Struct({ assistantId: AssistantId });
export type AssistantsDeleteResult = typeof AssistantsDeleteResult.Type;

export class AssistantError extends Schema.TaggedError<AssistantError>()("AssistantError", {
  reason: Schema.Literals(["not_found", "handle_taken", "invalid", "storage"]),
  message: Schema.String,
}) {}
