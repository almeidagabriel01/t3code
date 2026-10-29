import {
  checklistProgress,
  isOverdue,
  kanbanColor,
  KANBAN_PRIORITY_LABELS,
} from "@t3tools/client-runtime/state/kanbanLogic";
import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type { KanbanCard } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

export function KanbanLabelChip(props: { readonly name: string; readonly color: string }) {
  return (
    <View
      className="rounded-full px-2 py-0.5"
      style={{ backgroundColor: `${kanbanColor(props.color)}33` }}
    >
      <Text textRole="caption" className="text-foreground">
        {props.name}
      </Text>
    </View>
  );
}

export function KanbanCardTile(props: {
  readonly card: KanbanCard;
  readonly board: Pick<KanbanBoardState, "labels" | "templates">;
  readonly projectLabel?: string | undefined;
  readonly now: number;
  readonly onPress: () => void;
}) {
  const { card } = props;
  const template = props.board.templates.find((entry) => entry.id === card.type);
  const labels = card.labelIds.flatMap(
    (id) => props.board.labels.find((label) => label.id === id) ?? [],
  );
  const progress = checklistProgress(card.checklist);
  const overdue = isOverdue(card, props.now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`#${card.number} ${card.title}`}
      onPress={props.onPress}
      className="gap-2 rounded-2xl border border-border bg-card p-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <Text textRole="caption" className="text-foreground-muted">
          #{card.number}
        </Text>
        {template ? (
          <Text textRole="caption" style={{ color: kanbanColor(template.color) }}>
            {template.name}
          </Text>
        ) : null}
        {props.projectLabel ? (
          <Text textRole="caption" numberOfLines={1} className="shrink text-foreground-muted">
            {props.projectLabel}
          </Text>
        ) : null}
        <View className="ml-auto flex-row items-center gap-2">
          {card.blockedBy.length > 0 ? (
            <Text textRole="caption" className="text-foreground-muted">
              Blocked
            </Text>
          ) : null}
          {card.priority !== "none" ? (
            <Text
              textRole="caption"
              className={
                card.priority === "urgent" ? "text-danger-foreground" : "text-foreground-muted"
              }
            >
              {KANBAN_PRIORITY_LABELS[card.priority]}
            </Text>
          ) : null}
        </View>
      </View>
      <Text textRole="body" numberOfLines={3} className="font-t3-medium text-foreground">
        {card.title}
      </Text>
      {labels.length > 0 ? (
        <View className="flex-row flex-wrap gap-1">
          {labels.map((label) => (
            <KanbanLabelChip key={label.id} name={label.name} color={label.color} />
          ))}
        </View>
      ) : null}
      {progress.total > 0 ||
      card.dueAt !== null ||
      card.attachments.length > 0 ||
      card.linkedThreadIds.length > 0 ? (
        <View className="flex-row items-center gap-3">
          {progress.total > 0 ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name="checkmark.circle"
                size={14}
                tintColorClassName="accent-icon-muted"
              />
              <Text textRole="caption" className="text-foreground-muted">
                {progress.done}/{progress.total}
              </Text>
            </View>
          ) : null}
          {card.dueAt !== null ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name="calendar.badge.clock"
                size={14}
                tintColorClassName={overdue ? "accent-danger-foreground" : "accent-icon-muted"}
              />
              <Text
                textRole="caption"
                className={overdue ? "text-danger-foreground" : "text-foreground-muted"}
              >
                {new Date(card.dueAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </Text>
            </View>
          ) : null}
          {card.attachments.length > 0 ? (
            <View
              className="flex-row items-center gap-1"
              accessibilityLabel={`${card.attachments.length} attachments`}
            >
              <SymbolView name="paperclip" size={14} tintColorClassName="accent-icon-muted" />
              <Text textRole="caption" className="text-foreground-muted">
                {card.attachments.length}
              </Text>
            </View>
          ) : null}
          {card.linkedThreadIds.length > 0 ? (
            <View className="ml-auto flex-row items-center gap-1">
              <SymbolView name="sparkles" size={14} tintColorClassName="accent-icon-muted" />
              <Text textRole="caption" className="text-foreground-muted">
                {card.linkedThreadIds.length}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
