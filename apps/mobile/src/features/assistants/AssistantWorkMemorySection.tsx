import { useNavigation } from "@react-navigation/native";
import { assistantMemories } from "@t3tools/client-runtime/assistantWork";
import {
  memoryBrowseInput,
  memoryPreview,
  memoryScopeLabel,
} from "@t3tools/client-runtime/memory-browsing";
import {
  AuthMemoryReadScope,
  MEMORY_PAGE_MAX_ITEMS,
  type Assistant,
  type EnvironmentId,
  type MemoryScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { useProjects } from "../../state/entities";
import { memoryEnvironment as memory } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useForgetMemory, useMemorySpace, useProjectMemoryScope } from "../memory/useProjectMemory";

const NO_ITEMS: ReadonlyArray<never> = [];

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
  const projectMemory = useProjectMemoryScope(
    environmentId,
    assistant.scope === "project" ? assistant.projectId : null,
    space,
  );
  const projectScope = projectMemory?.status === "ready" ? projectMemory.scope : null;
  const forgetMemory = useForgetMemory(environmentId);
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
                  onPress={() => forgetMemory(entry.item)}
                />
              </View>
            );
          })}
        </ListSection>
      )}
    </View>
  );
}
