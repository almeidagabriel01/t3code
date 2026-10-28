import { useNavigation } from "@react-navigation/native";
import {
  boardScopeKey,
  collectGlobalBoards,
  isWipExceeded,
  kanbanColor,
} from "@t3tools/client-runtime/state/kanbanLogic";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useMemo, useState } from "react";
import { FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { useProjects } from "../../state/entities";
import { useKanbanStates } from "../../state/kanban";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ALL_PROJECTS, buildBoardColumns, type BoardViewColumn } from "./kanbanBoardView";
import { KanbanCardTile } from "./KanbanCardTile";
import { useKanbanActions } from "./useKanbanActions";

function AddCardButton(props: { readonly addTo: NonNullable<BoardViewColumn["addTo"]> }) {
  const { addTo } = props;
  const { canEdit, createCard } = useKanbanActions(addTo.environmentId);
  if (!canEdit) return null;
  return (
    <Button
      label="Add card"
      icon="plus"
      tone="text"
      onPress={() =>
        Dialog.prompt({
          title: "New card",
          placeholder: "Title",
          initialValue: "",
          confirmText: "Add",
          onConfirm: (value) => {
            const title = value.trim();
            if (title.length > 0) {
              void createCard({ boardId: addTo.boardId, columnId: addTo.columnId, title });
            }
          },
        })
      }
    />
  );
}

function ColumnPage(props: {
  readonly column: BoardViewColumn;
  readonly position: string;
  readonly width: number;
  readonly now: number;
  readonly projectLabel: (environmentId: EnvironmentId, projectId: string) => string;
}) {
  const navigation = useNavigation();
  const { column } = props;
  const exceeded = isWipExceeded(column, column.cards.length);
  return (
    <View style={{ width: props.width }}>
      <View className="gap-3 px-4 pb-10">
        <View className="flex-row items-center gap-2 pt-1">
          {column.color !== null ? (
            <View
              className="size-2.5 rounded-full"
              style={{ backgroundColor: kanbanColor(column.color) }}
            />
          ) : null}
          <Text
            textRole="headline"
            numberOfLines={1}
            className="shrink font-t3-bold text-foreground"
          >
            {column.title}
          </Text>
          <Text
            textRole="footnote"
            className={exceeded ? "text-danger-foreground" : "text-foreground-muted"}
          >
            {column.wipLimit === null
              ? column.cards.length
              : `${column.cards.length}/${column.wipLimit}`}
          </Text>
          <Text textRole="caption" className="ml-auto text-foreground-muted">
            {props.position}
          </Text>
        </View>
        {column.cards.length === 0 ? (
          <Text textRole="footnote" className="py-6 text-center text-foreground-muted">
            No cards
          </Text>
        ) : (
          column.cards.map(({ environmentId, board, card, projectId }) => (
            <KanbanCardTile
              key={card.id}
              card={card}
              board={board}
              now={props.now}
              projectLabel={
                projectId === null ? undefined : props.projectLabel(environmentId, projectId)
              }
              onPress={() =>
                navigation.navigate("SettingsKanbanCard", { environmentId, cardId: card.id })
              }
            />
          ))
        )}
        {column.addTo ? <AddCardButton addTo={column.addTo} /> : null}
      </View>
    </View>
  );
}

export function KanbanBoardRouteScreen() {
  const states = useKanbanStates();
  const projects = useProjects();
  const [scope, setScope] = useState(ALL_PROJECTS);
  const [width, setWidth] = useState(0);
  const boards = useMemo(() => collectGlobalBoards(states), [states]);
  const projectTitle = (environmentId: EnvironmentId, projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";
  const options = boards.map(({ environmentId, board }) => ({
    key: boardScopeKey(environmentId, board.projectId),
    title: projectTitle(environmentId, board.projectId),
  }));
  const activeScope = options.some((option) => option.key === scope) ? scope : ALL_PROJECTS;
  const columns = useMemo(() => buildBoardColumns(boards, activeScope), [boards, activeScope]);
  const now = useNowMinuteMs();
  const actions: MenuAction[] = [
    { id: ALL_PROJECTS, title: "All projects", state: activeScope === ALL_PROJECTS ? "on" : "off" },
    ...options.map((option) => ({
      id: option.key,
      title: option.title,
      state: activeScope === option.key ? ("on" as const) : ("off" as const),
    })),
  ];
  const loading =
    states.length > 0 && states.every((entry) => entry.state === null && !entry.error);

  return (
    <SettingsScreen title="Board">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        // Columns share this one vertical scroll so the header inset applies once.
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {states.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No boards"
            detail="None of your connected environments supports boards."
          />
        ) : loading ? (
          <EmptyState
            variant="plain"
            title="Loading boards"
            detail="Connecting to your environments."
          />
        ) : boards.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No boards yet"
            detail="Open a project's board on desktop or web to create it."
          />
        ) : (
          <>
            <View className="flex-row px-4 py-3">
              <Menu
                actions={actions}
                onPressAction={({ nativeEvent }) => setScope(nativeEvent.event)}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Choose project"
                  className="min-h-9 flex-row items-center gap-2 rounded-full bg-secondary px-4 active:opacity-70"
                >
                  <Text
                    textRole="footnote"
                    numberOfLines={1}
                    className="font-t3-medium text-foreground"
                  >
                    {options.find((option) => option.key === activeScope)?.title ?? "All projects"}
                  </Text>
                  <SymbolView name="chevron.down" size={12} tintColorClassName="accent-chevron" />
                </Pressable>
              </Menu>
            </View>
            {width > 0 ? (
              <FlatList
                horizontal
                pagingEnabled
                data={columns}
                keyExtractor={(column) => column.key}
                showsHorizontalScrollIndicator={false}
                getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
                renderItem={({ item, index }) => (
                  <ColumnPage
                    column={item}
                    position={`${index + 1} of ${columns.length}`}
                    width={width}
                    now={now}
                    projectLabel={projectTitle}
                  />
                )}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
