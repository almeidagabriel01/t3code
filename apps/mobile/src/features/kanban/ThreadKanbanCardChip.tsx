import { useNavigation } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useThreadKanbanCard } from "../../state/kanban";
import { useKanbanActions } from "./useKanbanActions";

/** Open always; switching and unlinking only for a session that can edit the board. */
export function threadCardMenuActions(canEdit: boolean): MenuAction[] {
  return [
    { id: "open", title: "Open card", image: "arrow.up.right.square" },
    ...(canEdit
      ? [
          { id: "switch", title: "Link to another card…", image: "arrow.left.arrow.right" },
          {
            id: "unlink",
            title: "Unlink from this thread",
            image: "xmark.circle.fill",
            attributes: { destructive: true },
          },
        ]
      : []),
  ];
}

/** The board card a thread is linked to; tapping opens a menu to open, switch or unlink it. */
export function ThreadKanbanCardChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const card = useThreadKanbanCard(props.environmentId, props.threadId);
  const actions = useKanbanActions(props.environmentId);
  if (card === null) return null;
  const run = (id: string) => {
    if (id === "open") {
      navigation.navigate("SettingsKanbanCard", {
        environmentId: props.environmentId,
        cardId: card.id,
      });
    } else if (id === "switch") {
      navigation.navigate("SettingsKanbanLinkCard", {
        environmentId: props.environmentId,
        threadId: props.threadId,
      });
    } else if (id === "unlink") {
      void actions.unlinkCardThread({ cardId: card.id, threadId: props.threadId });
    }
  };
  return (
    <View className="mx-3 mb-2 self-start">
      <Menu
        actions={threadCardMenuActions(actions.canEdit)}
        onPressAction={({ nativeEvent }) => run(nativeEvent.event)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Card #${card.number} actions`}
          className="min-h-9 flex-row items-center gap-2 rounded-full bg-secondary px-3 active:opacity-70"
        >
          <SymbolView name="square.grid.2x2" size={14} tintColorClassName="accent-icon-muted" />
          <Text
            textRole="footnote"
            numberOfLines={1}
            className="shrink font-t3-medium text-foreground"
          >
            #{card.number} {card.title}
          </Text>
        </Pressable>
      </Menu>
    </View>
  );
}
