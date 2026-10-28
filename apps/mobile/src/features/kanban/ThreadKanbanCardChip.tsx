import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadKanbanCard } from "../../state/kanban";

/** The board card a thread is linked to; opens the card. */
export function ThreadKanbanCardChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const card = useThreadKanbanCard(props.environmentId, props.threadId);
  if (card === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open card #${card.number}`}
      onPress={() =>
        navigation.navigate("SettingsKanbanCard", {
          environmentId: props.environmentId,
          cardId: card.id,
        })
      }
      className="mx-3 mb-2 min-h-9 flex-row items-center gap-2 self-start rounded-full bg-secondary px-3 active:opacity-70"
    >
      <SymbolView name="square.grid.2x2" size={14} tintColorClassName="accent-icon-muted" />
      <Text textRole="footnote" numberOfLines={1} className="shrink font-t3-medium text-foreground">
        #{card.number} {card.title}
      </Text>
    </Pressable>
  );
}
