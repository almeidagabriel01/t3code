import { threadOwnerResolver, type ZoneShell } from "@t3tools/client-runtime/sidebarZones";

/**
 * Who started each thread, from the assistants' tasks and groups. Owned threads leave the project
 * lists (and their ordering) for the Teams zone; an archived assistant's work goes back to projects.
 */
export function buildThreadOwnership(input: {
  readonly shells: ReadonlyArray<ZoneShell>;
  readonly active: ReadonlyArray<{
    readonly environmentId: string;
    readonly assistant: { readonly id: string };
  }>;
  readonly activeTeams: ReadonlyArray<{
    readonly environmentId: string;
    readonly team: {
      readonly id: string;
      readonly chat?: { readonly threadIds: ReadonlyArray<string> } | undefined;
    };
  }>;
  /** `env:assistantId` → its tasks, dismissed ones included. */
  readonly tasksByAssistant: ReadonlyMap<string, ReadonlyArray<{ readonly threadId: string }>>;
}) {
  const taskAssistantByThreadKey = new Map<string, string>();
  for (const { environmentId, assistant } of input.active) {
    const assistantKey = `${environmentId}:${assistant.id}`;
    for (const task of input.tasksByAssistant.get(assistantKey) ?? []) {
      taskAssistantByThreadKey.set(`${environmentId}:${task.threadId}`, assistantKey);
    }
  }
  const teamKeyByThreadKey = new Map(
    input.activeTeams.flatMap(({ environmentId, team }) =>
      (team.chat?.threadIds ?? []).map(
        (threadId) => [`${environmentId}:${threadId}`, `${environmentId}:${team.id}`] as const,
      ),
    ),
  );
  const ownerOf = threadOwnerResolver({
    shells: input.shells,
    taskAssistantByThreadKey,
    teamKeyByThreadKey,
    activeAssistantKeys: new Set(
      input.active.map(({ environmentId, assistant }) => `${environmentId}:${assistant.id}`),
    ),
  });
  const ownedThreadKeys = new Set(
    input.shells.flatMap((shell) =>
      ownerOf(shell).kind === "assistant" ? [`${shell.environmentId}:${shell.id}`] : [],
    ),
  );
  return { ownerOf, ownedThreadKeys };
}

export type ThreadOwnership = ReturnType<typeof buildThreadOwnership>;

/** The same set when its keys did not change, so list memos keyed on it hold. */
export function sameKeySet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}
