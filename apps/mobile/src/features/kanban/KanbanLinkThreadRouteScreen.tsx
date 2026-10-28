import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { selectKanbanThreadCards } from "@t3tools/client-runtime/state/kanban";
import { collectGlobalBoards, findCardInBoards } from "@t3tools/client-runtime/state/kanbanLogic";
import { EnvironmentId, KanbanCardId, type ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { useThreadShells } from "../../state/entities";
import { useKanbanStates } from "../../state/kanban";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useKanbanActions } from "./useKanbanActions";

const MAX_ROWS = 50;

/** Links one of the card's project threads to it. */
export function KanbanLinkThreadRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; cardId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const cardId = KanbanCardId.make(route.params.cardId);
  const navigation = useNavigation();
  const states = useKanbanStates();
  const threads = useThreadShells();
  const actions = useKanbanActions(environmentId);
  const [query, setQuery] = useState("");
  const found = findCardInBoards(collectGlobalBoards(states), cardId);
  const state = states.find((entry) => entry.environmentId === environmentId)?.state ?? null;
  const linked = state === null ? null : selectKanbanThreadCards(state);
  const text = query.trim().toLowerCase();
  const candidates =
    found === null
      ? []
      : threads
          .filter(
            (thread) =>
              thread.environmentId === environmentId &&
              thread.projectId === found.board.projectId &&
              thread.archivedAt === null &&
              thread.deletedAt === null &&
              (text === "" || thread.title.toLowerCase().includes(text)),
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, MAX_ROWS);
  const noteFor = (threadId: ThreadId) => {
    const other = linked?.get(threadId);
    if (other === undefined) return null;
    return other.id === cardId ? "Linked" : `On #${other.number}`;
  };
  return (
    <SettingsScreen
      title="Link thread"
      search={{ value: query, onChangeText: setQuery, placeholder: "Search threads" }}
    >
      {candidates.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No threads found"
          detail="Threads of this card's project show up here."
        />
      ) : (
        <FlatList
          data={candidates}
          keyExtractor={(thread) => thread.id}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const note = noteFor(item.id);
            return (
              <Pressable
                accessibilityRole="button"
                disabled={note !== null}
                onPress={async () => {
                  if (await actions.linkCardThread({ cardId, threadId: item.id })) {
                    navigation.goBack();
                  }
                }}
                className="min-h-12 flex-row items-center gap-3 px-5 py-3 active:opacity-70"
              >
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-base text-foreground">
                    {item.title}
                  </Text>
                </View>
                <Text className="text-xs text-foreground-muted">
                  {note ?? item.runtime?.status ?? "idle"}
                </Text>
              </Pressable>
            );
          }}
        />
      )}
    </SettingsScreen>
  );
}
