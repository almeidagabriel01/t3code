import {
  assistantIdFromThreadId,
  type AssistantTask,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import { assistantTaskState } from "./assistantTasks.ts";
import type { AssistantFace } from "./assistantRobot.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import {
  activeSubagentChildrenByParent,
  resolveSidebarThreadStatus,
} from "./state/threadAttention.ts";

/** A project an assistant is working in right now, and the thread there to open. */
export interface AssistantWorkSite {
  readonly environmentId: EnvironmentId;
  readonly assistantId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** "waiting" when the work there waits on the user, so its face matches the label beside it. */
  readonly face: Extract<AssistantFace, "working" | "waiting">;
}

export interface AssistantLiveWork {
  /** Newest first; one per assistant and project, pointing at the newest live thread there. */
  readonly sites: ReadonlyArray<AssistantWorkSite>;
  /** Live delegated children of each assistant's own and group threads, by `env:assistantId`, oldest first. */
  readonly subagents: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;
  /** `env:threadId` of every task an assistant still lists, live or finished. */
  readonly taskThreadKeys: ReadonlySet<string>;
}

const NEEDS_USER = new Set(["approval", "input", "request"]);

/**
 * What each assistant is doing outside its own chat: launched tasks that still run or wait on the
 * user, and delegated children that the project lists already hide under their parent.
 */
export function assistantLiveWork(input: {
  readonly tasks: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly task: AssistantTask;
  }>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
}): AssistantLiveWork {
  const shellByKey = new Map(
    input.shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]),
  );
  const found: Array<AssistantWorkSite & { readonly at: string }> = [];
  const taskThreadKeys = new Set<string>();
  for (const { environmentId, task } of input.tasks) {
    if (task.dismissedAt != null) continue;
    taskThreadKeys.add(`${environmentId}:${task.threadId}`);
    const shell = shellByKey.get(`${environmentId}:${task.threadId}`);
    if (shell === undefined || shell.archivedAt !== null) continue;
    const state = assistantTaskState(shell);
    if (state !== "running" && state !== "waiting") continue;
    found.push({
      environmentId,
      assistantId: task.assistantId,
      projectId: shell.projectId,
      threadId: shell.id,
      face: state === "waiting" ? "waiting" : "working",
      at: task.createdAt,
    });
  }
  const subagents = new Map<string, EnvironmentThreadShell[]>();
  for (const children of activeSubagentChildrenByParent(input.shells).values()) {
    const parentId = children[0]?.lineage.parentThreadId;
    const assistantId = parentId == null ? null : assistantIdFromThreadId(parentId);
    if (assistantId === null) continue;
    const key = `${children[0]!.environmentId}:${assistantId}`;
    subagents.set(key, [...(subagents.get(key) ?? []), ...children]);
    for (const child of children) {
      found.push({
        environmentId: child.environmentId,
        assistantId,
        projectId: child.projectId,
        threadId: child.id,
        face: NEEDS_USER.has(resolveSidebarThreadStatus(child)) ? "waiting" : "working",
        at: child.createdAt,
      });
    }
  }
  // A pinned child stays listed after it finishes, as a pinned thread stays in a project list.
  for (const shell of input.shells) {
    const parentId = shell.lineage.parentThreadId;
    if (shell.pinnedAt == null || shell.archivedAt != null || parentId == null) continue;
    if (shell.lineage.relationshipToParent !== "subagent") continue;
    const assistantId = assistantIdFromThreadId(parentId);
    if (assistantId === null) continue;
    const key = `${shell.environmentId}:${assistantId}`;
    const list = subagents.get(key) ?? [];
    if (!list.includes(shell)) subagents.set(key, [...list, shell]);
  }
  for (const list of subagents.values())
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  found.sort((a, b) => b.at.localeCompare(a.at) || a.threadId.localeCompare(b.threadId));
  const seen = new Set<string>();
  const sites: AssistantWorkSite[] = [];
  for (const { at: _at, ...site } of found) {
    const key = `${site.environmentId}:${site.assistantId}:${site.projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push(site);
  }
  return { sites, subagents, taskThreadKeys };
}

/**
 * The faces a project row shows: assistants working there first (with the thread to open), then
 * its configured assistants. Each assistant once; a project can span environments.
 */
export function projectAssistantFaces<
  A extends { readonly environmentId: string; readonly assistant: { readonly id: string } },
>(input: {
  readonly assistants: ReadonlyArray<A>;
  readonly configured: ReadonlyArray<A>;
  readonly sites: ReadonlyArray<AssistantWorkSite>;
  readonly members: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>;
}): ReadonlyArray<{ readonly entry: A; readonly site: AssistantWorkSite | null }> {
  const keyOf = (environmentId: string, assistantId: string) => `${environmentId}:${assistantId}`;
  const byKey = new Map(
    input.assistants.map((entry) => [keyOf(entry.environmentId, entry.assistant.id), entry]),
  );
  const faces: Array<{ entry: A; site: AssistantWorkSite | null }> = [];
  const seen = new Set<string>();
  for (const site of input.sites) {
    const key = keyOf(site.environmentId, site.assistantId);
    const entry = byKey.get(key);
    if (
      entry === undefined ||
      seen.has(key) ||
      !input.members.some(
        (member) =>
          member.environmentId === site.environmentId && member.projectId === site.projectId,
      )
    ) {
      continue;
    }
    seen.add(key);
    faces.push({ entry, site });
  }
  for (const entry of input.configured) {
    const key = keyOf(entry.environmentId, entry.assistant.id);
    if (seen.has(key)) continue;
    seen.add(key);
    faces.push({ entry, site: null });
  }
  return faces;
}

/** The approved tooltip of a working face. */
export const assistantWorkingHereLabel = (name: string) => `${name} is working here`;
