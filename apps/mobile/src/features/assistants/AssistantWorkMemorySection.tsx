import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { assistantMemories } from "@t3tools/client-runtime/assistantWork";
import {
  memoryBrowseInput,
  memoryPreview,
  memoryProjectScope,
  memoryScopeLabel,
} from "@t3tools/client-runtime/memory-browsing";
import { memoryLocalSpace } from "@t3tools/client-runtime/memory-presentation";
import {
  AuthMemoryReadScope,
  MEMORY_PAGE_MAX_ITEMS,
  MemoryOperationId,
  type Assistant,
  type EnvironmentId,
  type MemoryScope,
  type MemorySpaceId,
} from "@t3tools/contracts";
import * as Crypto from "expo-crypto";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { useProjects } from "../../state/entities";
import { memoryEnvironment as memory } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { memoryExpectedHeads } from "../settings/SettingsMemoryRouteScreen.logic";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

const NO_ITEMS: ReadonlyArray<never> = [];

/** The environment's local memory space; null until the server reports one. */
function useMemorySpace(environmentId: EnvironmentId, enabled: boolean): MemorySpaceId | null {
  const canSync = useAtomValue(memory.syncStatus.permissionAtom(environmentId));
  const getSync = useAtomCommand(memory.syncStatus, { reportFailure: false });
  const [space, setSpace] = useState<MemorySpaceId | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's memory space from the server
  useEffect(() => {
    if (!enabled || !canSync) return;
    let current = true;
    void getSync({ environmentId, input: {} }).then((result) => {
      if (current && result._tag === "Success") setSpace(memoryLocalSpace(result.value));
    });
    return () => {
      current = false;
    };
  }, [canSync, enabled, environmentId, getSync]);
  return space;
}

/** The project's shared memory key needs a binding lookup; only a project assistant has one. */
function useProjectScope(
  environmentId: EnvironmentId,
  assistant: Assistant,
  space: MemorySpaceId | null,
): MemoryScope | null {
  const projects = useProjects();
  const canBind = useAtomValue(memory.projectBindingGet.permissionAtom(environmentId));
  const getBinding = useAtomCommand(memory.projectBindingGet, { reportFailure: false });
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const repositoryIdentity = projects.find(
    (project) => project.environmentId === environmentId && project.id === assistant.projectId,
  )?.repositoryIdentity;
  const wanted = assistant.scope === "project" && canBind && space !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the project's shared memory key from the server
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    void getBinding({
      environmentId,
      input: { memorySpaceId: space, project: { environmentId, projectId: assistant.projectId } },
    }).then((result) => {
      if (current && result._tag === "Success")
        setScope(memoryProjectScope(result.value, repositoryIdentity));
    });
    return () => {
      current = false;
    };
  }, [assistant.projectId, environmentId, getBinding, repositoryIdentity, space, wanted]);
  return wanted ? scope : null;
}

/** What the assistant's conversations taught the memory: open one in Memory to edit, or forget it. */
export function AssistantWorkMemorySection(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
}) {
  const { environmentId, assistant } = props;
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const canRead = useEnvironmentScope(environmentId, AuthMemoryReadScope);
  const space = useMemorySpace(environmentId, canRead);
  const projectScope = useProjectScope(environmentId, assistant, space);
  const forget = useAtomCommand(memory.forget, { reportFailure: false });
  const list = (scope: MemoryScope | null) =>
    space === null || scope === null
      ? null
      : memory.list({
          environmentId,
          input: {
            ...memoryBrowseInput({ memorySpaceId: space, scope, limit: MEMORY_PAGE_MAX_ITEMS }),
            includeQuarantined: false,
          },
        });
  const user = useEnvironmentQuery(list({ kind: "user" }));
  const project = useEnvironmentQuery(list(projectScope));
  const thread = useEnvironmentQuery(
    list(
      assistant.threadId === null
        ? null
        : { kind: "thread", thread: { environmentId, threadId: assistant.threadId } },
    ),
  );
  const itemsOf = (query: typeof user) =>
    (query.data ? Option.getOrNull(query.data)?.items : null) ?? NO_ITEMS;
  const memories = assistantMemories(
    [...itemsOf(thread), ...itemsOf(project), ...itemsOf(user)],
    assistant.id,
    environmentId,
    new Set(assistant.threadId === null ? [] : [assistant.threadId]),
  );
  const failed = [user, project, thread].some((query) => query.error !== null);

  const forgetMemory = (entry: (typeof memories)[number]) =>
    Dialog.confirm({
      title: "Forget this memory?",
      message: "This cannot be undone.",
      confirmText: "Forget",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const result = await forget({
            environmentId,
            input: {
              memorySpaceId: entry.item.memorySpaceId,
              memoryId: entry.item.memoryId,
              expectedHeads: memoryExpectedHeads(entry.item),
              operationId: MemoryOperationId.make(Crypto.randomUUID()),
            },
          });
          if (result._tag === "Failure" || result.value.outcome === "rejected")
            Dialog.alert(
              "Could not forget this memory",
              "Open it in Memory to review the record before trying again.",
            );
        })();
      },
    });

  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          Memory
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          What its conversations taught the memory. Tap one to edit it in Memory.
        </Text>
      </View>
      {!canRead ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          Memory read permission is required to see what it remembers.
        </Text>
      ) : space === null ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          Memory is off or still getting ready on this server.
        </Text>
      ) : memories.length === 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {failed ? "Some memories could not be loaded." : "Nothing remembered yet."}
        </Text>
      ) : (
        <ListSection>
          {memories.map((entry) => {
            const scopeLabel =
              entry.item.scope.kind === "project"
                ? (projects.find(
                    (candidate) =>
                      candidate.environmentId === environmentId &&
                      candidate.id === assistant.projectId,
                  )?.title ?? "Project")
                : memoryScopeLabel(entry.item.scope);
            return (
              <View key={entry.item.memoryId} className="flex-row items-center bg-grouped-card">
                <RowPressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit memory: ${memoryPreview(entry.item.payload.text)}`}
                  onPress={() =>
                    navigation.navigate("SettingsMemory", {
                      environmentId,
                      memorySpaceId: entry.item.memorySpaceId,
                      memoryId: entry.item.memoryId,
                    })
                  }
                  className="min-w-0 flex-1 bg-grouped-card"
                >
                  <ListRowLayout
                    icon="note.text"
                    label={memoryPreview(entry.item.payload.text)}
                    description={
                      entry.sourceThreadId === null
                        ? scopeLabel
                        : `${scopeLabel} · from a conversation`
                    }
                  />
                </RowPressable>
                {entry.sourceThreadId === null ? null : (
                  <IconButton
                    accessibilityLabel="Open source conversation"
                    icon="arrow.up.right.square"
                    onPress={() =>
                      selectDetail({
                        name: "Thread",
                        params: {
                          environmentId: String(environmentId),
                          threadId: String(entry.sourceThreadId),
                        },
                      })
                    }
                  />
                )}
                <IconButton
                  accessibilityLabel="Forget memory"
                  icon="xmark.circle.fill"
                  onPress={() => forgetMemory(entry)}
                />
              </View>
            );
          })}
        </ListSection>
      )}
    </View>
  );
}
