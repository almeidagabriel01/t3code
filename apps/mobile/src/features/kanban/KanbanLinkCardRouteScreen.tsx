import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  collectGlobalBoards,
  findCardInBoards,
  kanbanCardPickerRows,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { useKanbanStates, useThreadKanbanCard } from "../../state/kanban";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useKanbanActions } from "./useKanbanActions";

const MAX_ROWS = 50;

/** Links a thread to a card of its project's board, or switches it to another card on that board. */
export function KanbanLinkCardRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; threadId: string; projectId?: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const navigation = useNavigation();
  const actions = useKanbanActions(environmentId);
  const current = useThreadKanbanCard(environmentId, threadId);
  const states = useKanbanStates();
  const [query, setQuery] = useState("");
  const boards = collectGlobalBoards(states);
  const board =
    current === null
      ? boards.find(
          (entry) =>
            entry.environmentId === environmentId &&
            entry.board.projectId === route.params.projectId,
        )?.board
      : findCardInBoards(boards, current.id)?.board;
  const rows = board ? kanbanCardPickerRows(board.cards.values(), query, MAX_ROWS) : [];
  return (
    <SettingsScreen
      title={current === null ? "Link to card" : "Switch card"}
      search={{ value: query, onChangeText: setQuery, placeholder: "Search cards" }}
    >
      {rows.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No cards found"
          detail="Cards on this project's board show up here."
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(card) => card.id}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              disabled={item.id === current?.id}
              onPress={async () => {
                // A thread belongs to one card, so switching lets go of the old one first.
                if (
                  current !== null &&
                  !(await actions.unlinkCardThread({ cardId: current.id, threadId }))
                ) {
                  return;
                }
                if (await actions.linkCardThread({ cardId: item.id, threadId })) {
                  navigation.goBack();
                }
              }}
              className="min-h-12 flex-row items-center gap-3 px-5 py-3 active:opacity-70"
            >
              <Text className="w-10 text-xs text-foreground-muted">#{item.number}</Text>
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-base text-foreground">
                  {item.title}
                </Text>
              </View>
              {item.id === current?.id ? (
                <Text className="text-xs text-foreground-muted">Linked</Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </SettingsScreen>
  );
}
