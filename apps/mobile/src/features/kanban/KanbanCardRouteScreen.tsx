import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  collectGlobalBoards,
  definitionOfDoneWarning,
  describeCardEvent,
  dueAtToInput,
  formatCardDuration,
  findCardInBoards,
  inputToDueAt,
  KANBAN_PRIORITIES,
  KANBAN_PRIORITY_LABELS,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { parseAttachmentImageSrc } from "@t3tools/shared/attachmentImageRefs";
import { subtaskProgress, subtasksOf } from "@t3tools/shared/kanbanSubtasks";
import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import {
  EnvironmentId,
  KanbanCardId,
  type KanbanCard,
  type KanbanChecklistItem,
  type KanbanColumnId,
  type KanbanLabelId,
  type KanbanPriority,
  type KanbanTemplateId,
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
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../../native/SelectableMarkdownText";
import { ThreadMarkdownImage } from "../threads/ThreadMarkdownImage";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { kanbanEnvironment, useKanbanStates } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { KanbanLabelChip } from "./KanbanCardTile";
import { useKanbanActions } from "./useKanbanActions";
import { useStartKanbanAgent } from "./useStartKanbanAgent";

type ChecklistInputItem = Omit<KanbanChecklistItem, "id"> & {
  readonly id?: KanbanChecklistItem["id"];
};

const NO_TYPE = "__none__";

function PropertyPill(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.value}`}
      disabled={props.disabled}
      className="min-h-9 flex-row items-center gap-2 rounded-full bg-secondary px-4 active:opacity-70"
    >
      <Text textRole="footnote" className="text-foreground-muted">
        {props.label}
      </Text>
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        {props.value}
      </Text>
      {props.disabled ? null : (
        <SymbolView name="chevron.down" size={12} tintColorClassName="accent-chevron" />
      )}
    </Pressable>
  );
}

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
  readonly onChange: (items: ReadonlyArray<ChecklistInputItem>) => void;
}) {
  const done = props.items.filter((item) => item.done).length;
  if (props.items.length === 0 && props.disabled) return null;
  return (
    <Section
      title={
        props.items.length === 0 ? props.title : `${props.title} ${done}/${props.items.length}`
      }
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {props.items.map((item, index) => (
          <View
            key={item.id}
            className={
              index === 0
                ? "flex-row items-center"
                : "flex-row items-center border-t border-border-subtle"
            }
          >
            <Pressable
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
              className="min-w-0 flex-1 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
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
            {props.disabled ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.text}`}
                hitSlop={8}
                onPress={() => props.onChange(props.items.filter((entry) => entry !== item))}
                className="px-4 py-3 active:opacity-70"
              >
                <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
              </Pressable>
            )}
          </View>
        ))}
      </View>
      {props.disabled ? null : (
        <Button
          label="Add item"
          icon="plus"
          tone="text"
          onPress={() =>
            Dialog.prompt({
              title: `Add to ${props.title.toLowerCase()}`,
              placeholder: "Text",
              initialValue: "",
              confirmText: "Add",
              onConfirm: (value) => {
                const text = value.trim();
                if (text.length > 0) props.onChange([...props.items, { text, done: false }]);
              },
            })
          }
        />
      )}
    </Section>
  );
}

function SubtaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly subtask: KanbanCard;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly onOpen: () => void;
  readonly onDetach: () => void;
}) {
  const { subtask, board } = props;
  const agent = useStartKanbanAgent(props.environmentId, board, subtask);
  const column = board.columns.find((entry) => entry.id === subtask.columnId);
  return (
    <View
      className={
        props.first
          ? "flex-row items-center"
          : "flex-row items-center border-t border-border-subtle"
      }
    >
      <Pressable
        accessibilityRole="button"
        onPress={props.onOpen}
        className="min-w-0 flex-1 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      >
        <Text textRole="body" numberOfLines={1} className="flex-1 text-foreground">
          #{subtask.number} {subtask.title}
        </Text>
        <Text textRole="caption" className="text-foreground-muted">
          {column?.name ?? ""}
        </Text>
      </Pressable>
      {props.disabled ? null : (
        <>
          {subtask.linkedThreadIds.length === 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Start agent for #${subtask.number}`}
              disabled={!agent.ready || agent.starting}
              hitSlop={8}
              onPress={() => void agent.start()}
              className="px-3 py-3 active:opacity-70"
            >
              <SymbolView name="sparkles" size={16} tintColorClassName="accent-icon-muted" />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Detach #${subtask.number}`}
            hitSlop={8}
            onPress={props.onDetach}
            className="px-3 py-3 active:opacity-70"
          >
            <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </>
      )}
    </View>
  );
}

export function KanbanCardRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; cardId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const cardId = KanbanCardId.make(route.params.cardId);
  const states = useKanbanStates();
  const found = useMemo(
    () => findCardInBoards(collectGlobalBoards(states), cardId),
    [states, cardId],
  );
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
  return (
    <KanbanCardDetail
      environmentId={environmentId}
      cardId={cardId}
      board={found.board}
      card={found.card}
    />
  );
}

function KanbanCardDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: KanbanCardId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
}) {
  const { environmentId, cardId, board, card } = props;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [expandedImage, setExpandedImage] = useState<FilePreviewSource | null>(null);
  const renderDescriptionImage: MarkdownImageRenderer = (image) => {
    const attachmentId = parseAttachmentImageSrc(image.href);
    return attachmentId === null ? null : (
      <ThreadMarkdownImage
        environmentId={environmentId}
        resource={{ _tag: "attachment", attachmentId }}
        alt={image.alt}
        onPressPreview={setExpandedImage}
      />
    );
  };
  const actions = useKanbanActions(environmentId);
  const agent = useStartKanbanAgent(environmentId, board, card);
  const query = useEnvironmentQuery(kanbanEnvironment.card({ environmentId, input: { cardId } }));
  const refreshedFor = useRef(card.updatedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- activity and linked threads come from getCard, so a card change must refetch it
  useEffect(() => {
    if (refreshedFor.current === card.updatedAt) return;
    refreshedFor.current = card.updatedAt;
    query.refresh();
  }, [card.updatedAt, query]);
  const openThread = useOpenLinkedThread();
  const markdownStyles = useMarkdownPreviewStyles();
  const [comment, setComment] = useState("");
  const [editingDescription, setEditingDescription] = useState<string | null>(null);

  const disabled = !actions.canEdit;
  const column = board.columns.find((entry) => entry.id === card.columnId);
  const template = board.templates.find((entry) => entry.id === card.type);
  const labels = card.labelIds.flatMap((id) => board.labels.find((label) => label.id === id) ?? []);
  const columnName = (id: string) =>
    board.columns.find((entry) => entry.id === id)?.name ?? "a column";
  const result = query.data;
  const parentCard = card.parentCardId === null ? undefined : board.cards.get(card.parentCardId);
  const subtasks = subtasksOf(board.cards.values(), cardId);
  const subtaskCount = subtaskProgress(subtasks, board.columns);

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
  const toggleLabel = (labelId: KanbanLabelId) =>
    void actions.updateCard({
      cardId,
      labelIds: card.labelIds.includes(labelId)
        ? card.labelIds.filter((id) => id !== labelId)
        : [...card.labelIds, labelId],
    });
  const editDue = () =>
    Dialog.prompt({
      title: "Due date",
      message: "YYYY-MM-DD, or empty to clear.",
      initialValue: dueAtToInput(card.dueAt),
      confirmText: "Save",
      onConfirm: (value) => {
        const text = value.trim();
        const dueAt = text === "" ? null : inputToDueAt(text);
        if (text !== "" && dueAt === null) {
          Dialog.alert("Invalid date", "Use the format YYYY-MM-DD.");
          return;
        }
        void actions.updateCard({ cardId, dueAt });
      },
    });
  const confirmDelete = () =>
    Dialog.confirm({
      title: `Delete #${card.number}?`,
      message: "The card, its comments and its activity are removed for good.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        navigation.goBack();
        void actions.deleteCard({ cardId });
      },
    });
  const submitComment = async () => {
    const body = comment.trim();
    if (body.length === 0) return;
    if (await actions.commentOnCard({ cardId, body })) setComment("");
  };
  const meta = [
    card.estimate === null ? null : `${card.estimate.value} ${card.estimate.unit}`,
    result?.costUsd == null ? null : `$${result.costUsd.toFixed(2)}`,
    result?.durationMs == null ? null : formatCardDuration(result.durationMs),
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
          <View className="flex-row flex-wrap items-center gap-2">
            <Menu
              actions={KANBAN_PRIORITIES.map((value) => ({
                id: value,
                title: KANBAN_PRIORITY_LABELS[value],
                state: value === card.priority ? ("on" as const) : ("off" as const),
              }))}
              onPressAction={({ nativeEvent }) =>
                void actions.updateCard({
                  cardId,
                  priority: nativeEvent.event as KanbanPriority,
                })
              }
            >
              <PropertyPill
                label="Priority"
                value={KANBAN_PRIORITY_LABELS[card.priority]}
                disabled={disabled}
              />
            </Menu>
            <Menu
              actions={[
                {
                  id: NO_TYPE,
                  title: "No type",
                  state: card.type === null ? ("on" as const) : ("off" as const),
                },
                ...board.templates.map((entry) => ({
                  id: entry.id,
                  title: entry.name,
                  state: entry.id === card.type ? ("on" as const) : ("off" as const),
                })),
              ]}
              onPressAction={({ nativeEvent }) =>
                void actions.updateCard({
                  cardId,
                  type:
                    nativeEvent.event === NO_TYPE ? null : (nativeEvent.event as KanbanTemplateId),
                })
              }
            >
              <PropertyPill label="Type" value={template?.name ?? "None"} disabled={disabled} />
            </Menu>
            {board.labels.length > 0 ? (
              <Menu
                actions={board.labels.map((label) => ({
                  id: label.id,
                  title: label.name,
                  state: card.labelIds.includes(label.id) ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent }) => toggleLabel(nativeEvent.event as KanbanLabelId)}
              >
                <PropertyPill
                  label="Labels"
                  value={labels.length === 0 ? "None" : String(labels.length)}
                  disabled={disabled}
                />
              </Menu>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Due date"
              disabled={disabled}
              onPress={editDue}
              className="min-h-9 flex-row items-center gap-2 rounded-full bg-secondary px-4 active:opacity-70"
            >
              <Text textRole="footnote" className="text-foreground-muted">
                Due
              </Text>
              <Text textRole="footnote" className="font-t3-medium text-foreground">
                {card.dueAt === null ? "None" : new Date(card.dueAt).toLocaleDateString()}
              </Text>
            </Pressable>
          </View>
          {meta.length > 0 ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {meta.join(" · ")}
            </Text>
          ) : null}
        </View>

        {editingDescription !== null ? (
          <Section title="Description">
            <RNTextInput
              accessibilityLabel="Description"
              autoFocus
              multiline
              value={editingDescription}
              onChangeText={setEditingDescription}
              placeholderTextColorClassName="accent-foreground-muted"
              className="min-h-32 rounded-2xl bg-grouped-card px-4 py-3 font-sans text-base text-foreground"
            />
            <View className="flex-row gap-2">
              <Button label="Cancel" tone="secondary" onPress={() => setEditingDescription(null)} />
              <Button
                label="Save"
                tone="primary"
                onPress={() => {
                  void actions.updateCard({ cardId, description: editingDescription });
                  setEditingDescription(null);
                }}
              />
            </View>
          </Section>
        ) : card.description.trim().length > 0 ? (
          <Section title="Description">
            <SelectableMarkdownText
              markdown={card.description}
              textStyle={markdownStyles.nativeTextStyle}
              onLinkPress={(href) => void Linking.openURL(href)}
              renderImage={renderDescriptionImage}
            />
            <FilePreviewModal
              source={expandedImage}
              onRequestClose={() => setExpandedImage(null)}
            />
            {disabled ? null : (
              <Button
                label="Edit description"
                icon="pencil"
                tone="text"
                onPress={() => setEditingDescription(card.description)}
              />
            )}
          </Section>
        ) : disabled ? null : (
          <Button
            label="Add description"
            icon="plus"
            tone="text"
            onPress={() => setEditingDescription("")}
          />
        )}

        <Checklist
          title="Checklist"
          items={card.checklist}
          disabled={disabled}
          onChange={(checklist) => void actions.updateCard({ cardId, checklist })}
        />
        <Checklist
          title="Acceptance criteria"
          items={card.acceptanceCriteria}
          disabled={disabled}
          onChange={(acceptanceCriteria) => void actions.updateCard({ cardId, acceptanceCriteria })}
        />

        {card.parentCardId !== null ? (
          <Section title="Subtask of">
            <Button
              label={
                parentCard ? `#${parentCard.number} ${parentCard.title}` : "Parent not on the board"
              }
              tone="secondary"
              disabled={parentCard === undefined}
              onPress={() =>
                navigation.navigate("SettingsKanbanCard", {
                  environmentId,
                  cardId: card.parentCardId!,
                })
              }
            />
            {disabled ? null : (
              <Button
                label="Detach from parent"
                tone="text"
                onPress={() => void actions.updateCard({ cardId, parentCardId: null })}
              />
            )}
          </Section>
        ) : subtasks.length > 0 || !disabled ? (
          <Section
            title={
              subtasks.length === 0
                ? "Subtasks"
                : `Subtasks ${subtaskCount.done}/${subtaskCount.total} done`
            }
          >
            {subtasks.length > 0 ? (
              <View className="overflow-hidden rounded-2xl bg-grouped-card">
                {subtasks.map((subtask, index) => (
                  <SubtaskRow
                    key={subtask.id}
                    environmentId={environmentId}
                    board={board}
                    subtask={subtask}
                    disabled={disabled}
                    first={index === 0}
                    onOpen={() =>
                      navigation.navigate("SettingsKanbanCard", {
                        environmentId,
                        cardId: subtask.id,
                      })
                    }
                    onDetach={() =>
                      void actions.updateCard({ cardId: subtask.id, parentCardId: null })
                    }
                  />
                ))}
              </View>
            ) : null}
            {disabled ? null : (
              <Button
                label="Add subtask"
                icon="plus"
                tone="text"
                onPress={() =>
                  Dialog.prompt({
                    title: "Add subtask",
                    placeholder: "Title",
                    initialValue: "",
                    confirmText: "Add",
                    onConfirm: (value) => {
                      const title = value.trim();
                      if (title.length > 0) {
                        void actions.createCard({ boardId: board.id, title, parentCardId: cardId });
                      }
                    },
                  })
                }
              />
            )}
          </Section>
        ) : null}

        {card.linkedThreadIds.length > 0 || !disabled ? (
          <Section title="Agents">
            {card.linkedThreadIds.length > 0 ? (
              <View className="overflow-hidden rounded-2xl bg-grouped-card">
                {card.linkedThreadIds.map((threadId, index) => {
                  const derived = result?.threads.find((thread) => thread.threadId === threadId);
                  return (
                    <View
                      key={threadId}
                      className={
                        index === 0
                          ? "flex-row items-center"
                          : "flex-row items-center border-t border-border-subtle"
                      }
                    >
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => openThread({ environmentId, threadId })}
                        className="min-w-0 flex-1 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
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
                      {disabled ? null : (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Unlink thread"
                          hitSlop={8}
                          onPress={() => void actions.unlinkCardThread({ cardId, threadId })}
                          className="px-4 py-3 active:opacity-70"
                        >
                          <SymbolView
                            name="xmark"
                            size={14}
                            tintColorClassName="accent-icon-muted"
                          />
                        </Pressable>
                      )}
                    </View>
                  );
                })}
              </View>
            ) : null}
            {disabled ? null : (
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label="Start with agent"
                  icon="sparkles"
                  tone="secondary"
                  loading={agent.starting}
                  disabled={!agent.ready}
                  onPress={() => void agent.start()}
                />
                <Button
                  label="Link thread"
                  icon="link"
                  tone="secondary"
                  onPress={() =>
                    navigation.navigate("SettingsKanbanLinkThread", {
                      environmentId,
                      cardId,
                    })
                  }
                />
              </View>
            )}
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
        {disabled ? null : (
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Archive"
              icon="archivebox"
              tone="secondary"
              onPress={() => {
                navigation.goBack();
                void actions.archiveCard({ cardId });
              }}
            />
            <Button label="Delete" icon="trash" tone="danger" onPress={confirmDelete} />
          </View>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
