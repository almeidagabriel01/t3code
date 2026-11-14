import {
  type Assistant,
  assistantEffectiveProjectIds,
  type AssistantTeam,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
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
 * The projects a member may work in for one group's request: its own and that group's, or "all"
 * when its scope is not limited. Every request permission check goes through it, never the union
 * of the members' projects.
 */
export const assistantProjects = (
  assistant: Pick<Assistant, "id" | "scope" | "projectIds">,
  team: Pick<AssistantTeam, "memberIds" | "archivedAt" | "projectIds">,
): ReadonlyArray<ProjectId> | "all" =>
  assistant.scope === "project" ? assistantEffectiveProjectIds(assistant, [team]) : "all";

export const assistantWorksIn = (
  assistant: Pick<Assistant, "id" | "scope" | "projectIds">,
  team: Pick<AssistantTeam, "memberIds" | "archivedAt" | "projectIds">,
  projectId: ProjectId,
): boolean => {
  const projects = assistantProjects(assistant, team);
  return projects === "all" || projects.includes(projectId);
};

/**
 * Why `threadId` may not start work there, or none. A project assistant stays inside its effective
 * projects, and one with several must name `projectId`: an omitted one would land in its home
 * project. `delegate_task` always runs in the caller's project, so it is refused for those.
 */
export const projectScopeRefusal = Effect.fn("AssistantSandboxPolicy.projectScopeRefusal")(
  function* (
    directory: Option.Option<AssistantDirectoryShape>,
    input: {
      readonly threadId: ThreadId | undefined;
      readonly projectId?: ProjectId | undefined;
      readonly elsewhere?: boolean | undefined;
      readonly delegate?: boolean | undefined;
    },
  ) {
    if (Option.isNone(directory) || input.threadId === undefined) return Option.none<string>();
    const found = yield* directory.value.forThread(input.threadId);
    if (Option.isNone(found) || found.value.assistant.scope !== "project") {
      return Option.none<string>();
    }
    if (input.elsewhere === true) return Option.some(PROJECT_SCOPE_REFUSAL);
    const projectIds = yield* effectiveProjectIdsOf(
      directory.value,
      found.value.assistant,
      found.value.team,
    );
    if (input.projectId !== undefined && input.delegate !== true) {
      return projectIds.includes(input.projectId)
        ? Option.none<string>()
        : Option.some(PROJECT_SCOPE_REFUSAL);
    }
    if (projectIds.length <= 1) return Option.none<string>();
    const titles =
      directory.value.projectTitles === undefined
        ? {}
        : yield* directory.value.projectTitles(projectIds);
    const list = projectIds.map((id) => projectLabel(id, titles[id])).join(", ");
    return Option.some(
      input.delegate === true
        ? `You work in several projects (${list}) and delegate_task runs only in this conversation's project. Start the work with t3_thread_launch and the projectId it belongs to.`
        : `You work in several projects: ${list}. Pass the projectId this work belongs to; if the request does not make it clear, ask the user first.`,
    );
  },
);

/**
 * The projects an assistant may work in; empty for scope "all". A member's group conversation
 * (`team` set) reaches its own projects and that group's only; any other thread, all its groups'.
 */
export const effectiveProjectIdsOf = (
  directory: AssistantDirectoryShape,
  assistant: Assistant,
  team?: AssistantTeam | null,
): Effect.Effect<ReadonlyArray<ProjectId>> =>
  assistant.scope !== "project"
    ? Effect.succeed([])
    : team !== undefined
      ? Effect.succeed(assistantEffectiveProjectIds(assistant, team === null ? [] : [team]))
      : directory.teamsOf(assistant).pipe(
          Effect.map((memberships) =>
            assistantEffectiveProjectIds(
              assistant,
              memberships.map((membership) => membership.team),
            ),
          ),
        );

const PROJECT_SCOPE_REFUSAL =
  "You are a project assistant: you may only launch, delegate and message work inside the projects on your list. Pass one of them as projectId, or ask the user to do this from another conversation.";

const MAX_PROJECT_TITLE = 80;

/** "title (id: x)" on one line; the bare id when the title is missing or blank. */
export const projectLabel = (id: string, title: string | undefined) => {
  const line = title?.replace(/\s+/g, " ").trim() ?? "";
  if (line === "") return id;
  return `${line.length > MAX_PROJECT_TITLE ? `${line.slice(0, MAX_PROJECT_TITLE - 1)}…` : line} (id: ${id})`;
};

/** The note line for a project assistant; `titles` maps project id to title, and may miss any id. */
export const projectScopeNoteLine = (
  projectIds: ReadonlyArray<string>,
  titles: Readonly<Record<string, string>> = {},
): string => {
  const list = projectIds.map((id) => projectLabel(id, titles[id])).join(", ");
  return projectIds.length === 1
    ? `You belong to one project: ${list}. Pass the id as projectId. Launch, delegate and message work only inside it; other projects are out of reach.`
    : `You work in: ${list}. If the request does not make clear which one, ask before changing anything. Always pass the id as projectId to t3_thread_launch, and to memory_remember for a fact about one project; delegate_task runs only in this conversation's project, so it is refused for you. Other projects are out of reach.`;
};

/** The note line for an assistant that works on this Mac, which may send one task to the container. */
export const HOST_CONTAINER_NOTE_LINE =
  "You work on this Mac. Only when the user asks for the container, send that one task there with t3_assistant container_task; everything else runs here.";
