import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AssistantDirectoryShape } from "./AssistantDirectory.ts";

/**
 * Why `threadId` may not start work at `target`, or none when it may. Only a sandboxed assistant is
 * held: its work runs in the sandbox container, so anything aimed at this machine or at another
 * environment is refused with the id to use instead. `target` is undefined for work on this machine.
 */
export const sandboxRefusal = Effect.fn("AssistantSandboxPolicy.refusal")(function* (
  directory: Option.Option<AssistantDirectoryShape>,
  input: {
    /** Undefined for a caller that is not a thread, which no assistant holds. */
    readonly threadId: ThreadId | undefined;
    readonly localEnvironmentId?: EnvironmentId | undefined;
    readonly target: EnvironmentId | undefined;
  },
) {
  if (Option.isNone(directory) || input.threadId === undefined) return Option.none<string>();
  const found = yield* directory.value.forThread(input.threadId);
  if (Option.isNone(found) || found.value.assistant.workspace !== "sandbox") {
    return Option.none<string>();
  }
  const sandbox = yield* directory.value.sandboxEnvironmentId;
  if (Option.isNone(sandbox)) {
    return Option.some(
      "Your workspace is the sandbox container, which is not linked yet, so this work cannot run. Tell the user to start the sandbox in Settings → Assistants. Do not run it on this Mac.",
    );
  }
  if (input.target !== undefined && input.target !== input.localEnvironmentId) {
    return input.target === sandbox.value
      ? Option.none<string>()
      : Option.some(
          `Your workspace is the sandbox container. Run this work there with environmentId=${sandbox.value}, not in ${input.target}.`,
        );
  }
  return Option.some(
    `Your workspace is the sandbox container: on this Mac you only read. Run this work in the sandbox by passing environmentId=${sandbox.value} (t3_thread_launch, or delegate_task with target.environmentId).`,
  );
});

/** The note line for a sandboxed assistant, with the environment id it launches work in. */
export function sandboxNoteLine(environmentId: string | null): string {
  return environmentId === null
    ? "Your workspace is the sandbox container, which is not linked yet: you cannot run commands or edit files until the user starts it in Settings → Assistants. On this Mac you only read."
    : `Your workspace is the sandbox container (environmentId ${environmentId}). On this Mac you only read: shell commands that change anything, and file edits, are blocked here. For any request to change files, run commands, install, build or test, start that work in the sandbox with t3_thread_launch (environmentId ${environmentId}) or delegate_task (target.environmentId ${environmentId}), then report its result.`;
}

/**
 * Why `threadId` may not start or message work in another project, or none when it may. Only a
 * project assistant is held: it works inside its own project. `projectId` is the project the work
 * lands in (undefined when the caller names none, which means its own); `elsewhere` is true for
 * work aimed at another environment, whose projects are never this one.
 */
export const projectScopeRefusal = Effect.fn("AssistantSandboxPolicy.projectScopeRefusal")(
  function* (
    directory: Option.Option<AssistantDirectoryShape>,
    input: {
      readonly threadId: ThreadId | undefined;
      readonly projectId?: ProjectId | undefined;
      readonly elsewhere?: boolean | undefined;
    },
  ) {
    if (Option.isNone(directory) || input.threadId === undefined) return Option.none<string>();
    const found = yield* directory.value.forThread(input.threadId);
    if (Option.isNone(found) || found.value.assistant.scope !== "project") {
      return Option.none<string>();
    }
    if (
      input.elsewhere !== true &&
      (input.projectId ?? found.value.assistant.projectId) === found.value.assistant.projectId
    ) {
      return Option.none<string>();
    }
    return Option.some(PROJECT_SCOPE_REFUSAL);
  },
);

const PROJECT_SCOPE_REFUSAL =
  "You are a project assistant: you may only launch, delegate and message work inside your own project. Omit the project, or ask the user to do this from another conversation.";

/** The note line for a project assistant. */
export const PROJECT_SCOPE_NOTE_LINE =
  "You belong to one project. Launch, delegate and message work only inside it; other projects are out of reach.";
