import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { assistantIdFromThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { restoreAssistantConversation, useAssistantEntries } from "../../state/assistants";
import * as Dialog from "../../components/ui/Dialog";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadSortOrder } from "./archivedThreadList";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";

export function ArchivedThreadsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sortOrder, setSortOrder] = useState<ArchivedThreadSortOrder>("newest");
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById],
  );
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const assistants = useAssistantEntries();
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  // An archived assistant's current conversation is managed from Settings > Assistants.
  const archivedAssistantThreadKeys = useMemo(
    () =>
      new Set(
        assistants.archived.flatMap(({ environmentId, assistant }) =>
          assistant.threadId === null ? [] : [`${environmentId}:${assistant.threadId}`],
        ),
      ),
    [assistants.archived],
  );
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentLabels,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
      }).flatMap((group) => {
        const threads = group.threads.filter(
          (thread) => !archivedAssistantThreadKeys.has(`${thread.environmentId}:${thread.id}`),
        );
        return threads.length === 0 ? [] : [{ ...group, threads }];
      }),
    [
      archivedAssistantThreadKeys,
      environmentLabels,
      searchQuery,
      selectedEnvironmentId,
      snapshots,
      sortOrder,
    ],
  );
  const assistantRestoreFor = (thread: EnvironmentThreadShell) => {
    const assistantId = assistantIdFromThreadId(thread.id);
    if (assistantId === null) return undefined;
    const entry = assistants.active.find(
      (candidate) =>
        candidate.environmentId === thread.environmentId && candidate.assistant.id === assistantId,
    );
    if (!entry) return null;
    return {
      assistantName: entry.assistant.name,
      onRestore: () => {
        void (async () => {
          const reply = await restoreAssistantConversation(thread.environmentId, {
            assistantId: entry.assistant.id,
            restoreThreadId: thread.id,
          });
          if (reply.ok) refreshArchivedThreadsForEnvironment(thread.environmentId);
          else Dialog.alert("Could not restore the conversation", reply.message);
        })();
      },
    };
  };
  const refreshChangedEnvironment = (thread: { readonly environmentId: EnvironmentId }) => {
    refreshArchivedThreadsForEnvironment(thread.environmentId);
  };
  const { unarchiveThread, confirmDeleteThread } =
    useArchivedThreadListActions(refreshChangedEnvironment);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return (
    <ArchivedThreadsScreen
      environments={environments}
      error={error}
      groups={groups}
      isLoading={isLoading}
      onDeleteThread={confirmDeleteThread}
      onEnvironmentChange={setSelectedEnvironmentId}
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortOrderChange={setSortOrder}
      onUnarchiveThread={unarchiveThread}
      assistantRestoreFor={assistantRestoreFor}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sortOrder={sortOrder}
    />
  );
}
