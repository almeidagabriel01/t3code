import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
    : `Your workspace is the sandbox container (environmentId ${environmentId}): run commands and edit files there by launching or delegating threads with that environmentId (t3_thread_launch, delegate_task with target.environmentId). On this Mac you only read; never edit files or run commands here.`;
}
