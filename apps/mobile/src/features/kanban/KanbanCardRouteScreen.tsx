import type { StaticScreenProps } from "@react-navigation/native";
import {
  collectGlobalBoards,
  definitionOfDoneWarning,
  describeCardEvent,
  findCardInBoards,
  KANBAN_PRIORITY_LABELS,
} from "@t3tools/client-runtime/state/kanbanLogic";
import {
  EnvironmentId,
  KanbanCardId,
  type KanbanChecklistItem,
  type KanbanColumnId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { kanbanEnvironment, useKanbanStates } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { KanbanLabelChip } from "./KanbanCardTile";
import { useKanbanActions } from "./useKanbanActions";

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function Checklist(props: {
  readonly title: string;
  readonly items: ReadonlyArray<KanbanChecklistItem>;
  readonly disabled: boolean;
  readonly onChange: (items: ReadonlyArray<KanbanChecklistItem>) => void;
}) {
  const done = props.items.filter((item) => item.done).length;
  return (
    <Section title={`${props.title} ${done}/${props.items.length}`}>
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {props.items.map((item, index) => (
          <Pressable
            key={item.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: item.done, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() =>
              props.onChange(
                props.items.map((entry) =>
                  entry === item ? { ...entry, done: !entry.done } : entry,
                ),
              )
            }
            className={
              index === 0
                ? "flex-row items-center gap-3 px-4 py-3 active:opacity-70"
                : "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            }
          >
            <SymbolView
              name={item.done ? "checkmark.circle.fill" : "circle"}
              size={20}
              tintColorClassName={item.done ? "accent-primary" : "accent-icon-muted"}
            />
            <Text
              textRole="body"
              className={item.done ? "flex-1 text-foreground-muted" : "flex-1 text-foreground"}
            >
              {item.text}
            </Text>
          </Pressable>
        ))}
      </View>
    </Section>
  );
}

export function KanbanCardRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; cardId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const cardId = KanbanCardId.make(route.params.cardId);
  const insets = useSafeAreaInsets();
  const states = useKanbanStates();
  const found = useMemo(
    () => findCardInBoards(collectGlobalBoards(states), cardId),
    [states, cardId],
  );
  const actions = useKanbanActions(environmentId);
  const query = useEnvironmentQuery(kanbanEnvironment.card({ environmentId, input: { cardId } }));
  const refreshedFor = useRef(found?.card.updatedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- activity and linked threads come from getCard, so a card change must refetch it
  useEffect(() => {
    const updatedAt = found?.card.updatedAt;
    if (refreshedFor.current === updatedAt) return;
    refreshedFor.current = updatedAt;
    query.refresh();
  }, [found?.card.updatedAt, query]);
  const openThread = useOpenLinkedThread();
  const markdownStyles = useMarkdownPreviewStyles();
  const [comment, setComment] = useState("");

  if (found === null || found.environmentId !== environmentId) {
    return (
      <SettingsScreen title="Card">
        <EmptyState
          variant="plain"
          title="Card not found"
          detail="It was deleted or archived, or its environment is not connected."
        />
      </SettingsScreen>
    );
  }
  const { board, card } = found;
  const disabled = !actions.canEdit;
  const column = board.columns.find((entry) => entry.id === card.columnId);
  const template = board.templates.find((entry) => entry.id === card.type);
  const labels = card.labelIds.flatMap((id) => board.labels.find((label) => label.id === id) ?? []);
  const columnName = (id: string) =>
    board.columns.find((entry) => entry.id === id)?.name ?? "a column";
  const result = query.data;

  const moveTo = async (columnId: KanbanColumnId) => {
    const target = board.columns.find((entry) => entry.id === columnId);
    if (target === undefined || columnId === card.columnId) return;
    const moved = await actions.moveCard({ cardId, columnId });
    const warning = moved ? definitionOfDoneWarning(board, card, target) : null;
    if (warning !== null) Dialog.alert("Moved without meeting the definition of done", warning);
  };
  const moveActions: MenuAction[] = board.columns.map((entry) => ({
    id: entry.id,
    title: entry.name,
    state: entry.id === card.columnId ? "on" : "off",
  }));
  const movePill = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Move to, currently ${column?.name ?? "unknown"}`}
      disabled={disabled}
      className="min-h-9 flex-row items-center gap-2 rounded-full bg-secondary px-4 active:opacity-70"
    >
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        {column?.name ?? "Move to…"}
      </Text>
      {disabled ? null : (
        <SymbolView name="chevron.down" size={12} tintColorClassName="accent-chevron" />
      )}
    </Pressable>
  );
  const submitComment = async () => {
    const body = comment.trim();
    if (body.length === 0) return;
    if (await actions.commentOnCard({ cardId, body })) setComment("");
  };
  const meta = [
    template?.name,
    card.priority === "none" ? null : KANBAN_PRIORITY_LABELS[card.priority],
    card.dueAt === null ? null : `Due ${new Date(card.dueAt).toLocaleDateString()}`,
    card.estimate === null ? null : `${card.estimate.value} ${card.estimate.unit}`,
    result?.costUsd == null ? null : `$${result.costUsd.toFixed(2)}`,
    result?.durationMs == null
      ? null
      : `${Math.max(1, Math.round(result.durationMs / 60_000))} min`,
  ].filter((entry) => entry !== null && entry !== undefined);

  return (
    <SettingsScreen title={`#${card.number}`}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rename card"
            disabled={disabled}
            onPress={() =>
              Dialog.prompt({
                title: "Rename card",
                initialValue: card.title,
                confirmText: "Save",
                onConfirm: (value) => {
                  const title = value.trim();
                  if (title.length > 0 && title !== card.title)
                    void actions.updateCard({ cardId, title });
                },
              })
            }
          >
            <Text textRole="title" className="font-t3-bold text-foreground">
              {card.title}
            </Text>
          </Pressable>
          <View className="flex-row flex-wrap items-center gap-2">
            {disabled ? (
              movePill
            ) : (
              <Menu
                actions={moveActions}
                onPressAction={({ nativeEvent }) =>
                  void moveTo(nativeEvent.event as KanbanColumnId)
                }
              >
                {movePill}
              </Menu>
            )}
            {labels.map((label) => (
              <KanbanLabelChip key={label.id} name={label.name} color={label.color} />
            ))}
          </View>
          {meta.length > 0 ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {meta.join(" · ")}
            </Text>
          ) : null}
        </View>

        {card.description.trim().length > 0 ? (
          <Section title="Description">
            <SelectableMarkdownText
              markdown={card.description}
              textStyle={markdownStyles.nativeTextStyle}
              onLinkPress={(href) => void Linking.openURL(href)}
            />
          </Section>
        ) : null}

        {card.checklist.length > 0 ? (
          <Checklist
            title="Checklist"
            items={card.checklist}
            disabled={disabled}
            onChange={(checklist) => void actions.updateCard({ cardId, checklist })}
          />
        ) : null}
        {card.acceptanceCriteria.length > 0 ? (
          <Checklist
            title="Acceptance criteria"
            items={card.acceptanceCriteria}
            disabled={disabled}
            onChange={(acceptanceCriteria) =>
              void actions.updateCard({ cardId, acceptanceCriteria })
            }
          />
        ) : null}

        {card.linkedThreadIds.length > 0 ? (
          <Section title="Agents">
            <View className="overflow-hidden rounded-2xl bg-grouped-card">
              {card.linkedThreadIds.map((threadId, index) => {
                const derived = result?.threads.find((thread) => thread.threadId === threadId);
                return (
                  <Pressable
                    key={threadId}
                    accessibilityRole="button"
                    onPress={() => openThread({ environmentId, threadId })}
                    className={
                      index === 0
                        ? "flex-row items-center gap-3 px-4 py-3 active:opacity-70"
                        : "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
                    }
                  >
                    <Text textRole="body" numberOfLines={1} className="flex-1 text-foreground">
                      {derived?.title ?? "Open thread"}
                    </Text>
                    {derived?.status ? (
                      <Text textRole="caption" className="text-foreground-muted">
                        {derived.status}
                      </Text>
                    ) : null}
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColorClassName="accent-chevron"
                    />
                  </Pressable>
                );
              })}
            </View>
          </Section>
        ) : null}

        <Section title="Activity">
          {result === null ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {query.error ?? "Loading…"}
            </Text>
          ) : (
            result.activity.map((event) => (
              <View key={event.id} className="gap-0.5">
                <Text textRole="caption" className="text-foreground-muted">
                  {event.actor === "user" ? "You" : event.actor.replace(/^agent:/, "Agent ")} ·{" "}
                  {new Date(event.createdAt).toLocaleString()}
                </Text>
                <Text
                  textRole="footnote"
                  className={event.kind === "comment" ? "text-foreground" : "text-foreground-muted"}
                >
                  {describeCardEvent(event, columnName)}
                </Text>
              </View>
            ))
          )}
          {disabled ? null : (
            <View className="gap-2 pt-1">
              <RNTextInput
                accessibilityLabel="Comment"
                value={comment}
                onChangeText={setComment}
                multiline
                placeholder="Add a comment"
                placeholderTextColorClassName="accent-foreground-muted"
                className="min-h-20 rounded-2xl bg-grouped-card px-4 py-3 font-sans text-base text-foreground"
              />
              <Button
                label="Comment"
                tone="secondary"
                disabled={comment.trim().length === 0}
                onPress={() => void submitComment()}
              />
            </View>
          )}
        </Section>
      </ScrollView>
    </SettingsScreen>
  );
}
