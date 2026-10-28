import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, KanbanBoardId } from "@t3tools/contracts";
import { FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { kanbanEnvironment } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useKanbanActions } from "./useKanbanActions";

export function KanbanArchiveRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; boardId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const boardId = KanbanBoardId.make(route.params.boardId);
  const actions = useKanbanActions(environmentId);
  const query = useEnvironmentQuery(
    kanbanEnvironment.archived({ environmentId, input: { boardId } }),
  );
  return (
    <SettingsScreen title="Archived cards">
      {query.data === null ? (
        <EmptyState
          variant="plain"
          title={query.error ?? "Loading archived cards"}
          detail={query.error === null ? "" : "Check the connection and try again."}
          action={
            query.error === null ? undefined : (
              <Button label="Retry" tone="secondary" onPress={() => query.refresh()} />
            )
          }
        />
      ) : query.data.cards.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No archived cards"
          detail="Archived cards leave the board and show up here."
        />
      ) : (
        <FlatList
          data={query.data.cards}
          keyExtractor={(card) => card.id}
          contentInsetAdjustmentBehavior="automatic"
          renderItem={({ item }) => (
            <View className="min-h-12 flex-row items-center gap-3 px-5 py-3">
              <Text numberOfLines={2} className="min-w-0 flex-1 text-base text-foreground">
                <Text className="text-foreground-muted">#{item.number}</Text> {item.title}
              </Text>
              {actions.canEdit ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Restore #${item.number}`}
                  onPress={async () => {
                    if (await actions.unarchiveCard({ cardId: item.id })) query.refresh();
                  }}
                  className="rounded-full bg-secondary px-4 py-2 active:opacity-70"
                >
                  <Text className="text-sm font-t3-medium text-foreground">Restore</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}
    </SettingsScreen>
  );
}
