import { threadOwnerResolver, type ZoneShell } from "@t3tools/client-runtime/sidebarZones";

/**
 * Who started each thread, from the assistants' tasks and groups. Teams draws an owned thread under
 * its assistant, and its project still lists it.
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
  return { ownerOf };
}

export type ThreadOwnership = ReturnType<typeof buildThreadOwnership>;
