import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  boardScopeKey,
  collectGlobalBoards,
  isWipExceeded,
  kanbanColor,
} from "@t3tools/client-runtime/state/kanbanLogic";
import type { EnvironmentId, KanbanTemplateId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
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
import { useProjects, useServerConfigs } from "../../state/entities";
import { useKanbanStates } from "../../state/kanban";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import {
  ALL_PROJECTS,
  buildBoardColumns,
  newBoardTargets,
  projectLabelsByScope,
  type BoardViewColumn,
  type NewBoardTarget,
} from "./kanbanBoardView";
import { KanbanCardMenu } from "./KanbanCardMenu";
import { KanbanCardTile } from "./KanbanCardTile";
import { useCreateKanbanBoard, useCreateKanbanCard } from "./useCreateKanbanBoard";
import { useKanbanActions } from "./useKanbanActions";

const NO_TEMPLATE = "__blank__";

function AddCardButton(props: { readonly addTo: NonNullable<BoardViewColumn["addTo"]> }) {
  const { addTo } = props;
  const { canEdit, createCard } = useKanbanActions(addTo.environmentId);
  if (!canEdit) return null;
  const add = (type: KanbanTemplateId | null) =>
    Dialog.prompt({
      title: "New card",
      placeholder: "Title",
      initialValue: "",
      confirmText: "Add",
      onConfirm: (value) => {
        const title = value.trim();
        if (title.length > 0) {
          void createCard({
            boardId: addTo.boardId,
            columnId: addTo.columnId,
            title,
            ...(type === null ? {} : { type }),
          });
        }
      },
    });
  const button = (
    <Button
      label="Add card"
      icon="plus"
      tone="text"
      onPress={() => (addTo.templates.length === 0 ? add(null) : undefined)}
    />
  );
  if (addTo.templates.length === 0) return button;
  return (
    <Menu
      actions={[
        { id: NO_TEMPLATE, title: "Blank card" },
        ...addTo.templates.map((template) => ({ id: template.id, title: template.name })),
      ]}
      onPressAction={({ nativeEvent }) =>
        add(nativeEvent.event === NO_TEMPLATE ? null : (nativeEvent.event as KanbanTemplateId))
      }
    >
      {button}
    </Menu>
  );
}

function NewBoardButton(props: {
  readonly targets: ReadonlyArray<NewBoardTarget>;
  readonly onCreated: (scopeKey: string) => void;
}) {
  const create = useCreateKanbanBoard();
  if (props.targets.length === 0) return null;
  return (
    <Menu
      actions={props.targets.map((target) => ({ id: target.key, title: target.title }))}
      onPressAction={({ nativeEvent }) => {
        const target = props.targets.find((entry) => entry.key === nativeEvent.event);
        if (target !== undefined) {
          void create(target).then((board) => board !== null && props.onCreated(board.scopeKey));
        }
      }}
    >
      <Button label="New board" icon="plus" tone="text" onPress={() => undefined} />
    </Menu>
  );
}

/** The merged board has no column to add to, so the project is chosen here. */
function NewCardButton(props: { readonly targets: ReadonlyArray<NewBoardTarget> }) {
  const create = useCreateKanbanCard();
  if (props.targets.length === 0) return null;
  return (
    <Menu
      actions={props.targets.map((target) => ({ id: target.key, title: target.title }))}
      onPressAction={({ nativeEvent }) => {
        const target = props.targets.find((entry) => entry.key === nativeEvent.event);
        if (target === undefined) return;
        Dialog.prompt({
          title: "New card",
          message: target.title,
          placeholder: "Title",
          initialValue: "",
          confirmText: "Add",
          onConfirm: (value) => {
            const title = value.trim();
            if (title.length > 0) void create(target, title);
          },
        });
      }}
    >
      <Button label="New card" icon="plus" tone="text" onPress={() => undefined} />
    </Menu>
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
          column.cards.map(({ environmentId, board, card, projectId }) => {
            const open = () =>
              navigation.navigate("SettingsKanbanCard", { environmentId, cardId: card.id });
            return (
              <KanbanCardMenu
                key={`${environmentId}:${card.id}`}
                environmentId={environmentId}
                board={board}
                card={card}
                onOpen={open}
              >
                <KanbanCardTile
                  card={card}
                  board={board}
                  now={props.now}
                  projectLabel={
                    projectId === null ? undefined : props.projectLabel(environmentId, projectId)
                  }
                  onPress={open}
                />
              </KanbanCardMenu>
            );
          })
        )}
        {column.addTo ? <AddCardButton addTo={column.addTo} /> : null}
      </View>
    </View>
  );
}

/** `scope` opens on one project's board, as a thread's project board does. */
export function KanbanBoardRouteScreen({
  route,
}: StaticScreenProps<{ readonly scope?: string } | undefined>) {
  const states = useKanbanStates();
  const projects = useProjects();
  const [scope, setScope] = useState(route.params?.scope ?? ALL_PROJECTS);
  const [width, setWidth] = useState(0);
  const boards = useMemo(() => collectGlobalBoards(states), [states]);
  const serverConfigs = useServerConfigs();
  const environments = states.map(({ environmentId }) => ({
    environmentId,
    scratchWorkspaceRoot: serverConfigs.get(environmentId)?.scratchWorkspaceRoot ?? null,
  }));
  const newTargets = newBoardTargets({
    environments,
    projects,
    boards,
  });
  const cardTargets = newBoardTargets({
    environments,
    projects,
    boards: [],
  });
  const labels = projectLabelsByScope({ environments, projects });
  const projectTitle = (environmentId: EnvironmentId, projectId: string) => {
    const project = projects.find(
      (entry) => entry.environmentId === environmentId && entry.id === projectId,
    );
    if (project === undefined) return "Project";
    return isScratchProject(project, serverConfigs.get(environmentId)?.scratchWorkspaceRoot)
      ? "No project"
      : (labels.get(boardScopeKey(environmentId, project.id)) ?? project.title);
  };
  const options = boards.map(({ environmentId, board }) => ({
    key: boardScopeKey(environmentId, board.projectId),
    title: projectTitle(environmentId, board.projectId),
  }));
  const activeScope = options.some((option) => option.key === scope) ? scope : ALL_PROJECTS;
  const columns = useMemo(() => buildBoardColumns(boards, activeScope), [boards, activeScope]);
  const now = useNowMinuteMs();
  const navigation = useNavigation();
  const archiveTarget = columns[0]?.addTo ?? null;
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
            detail="Create the first board for a project, or for threads without a project."
            action={<NewBoardButton targets={newTargets} onCreated={setScope} />}
          />
        ) : (
          // Measure the content, not the scroll view: Android caps the content width, so pages sized to the scroll view overflow on tablets.
          <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
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
              <NewBoardButton targets={newTargets} onCreated={setScope} />
              {activeScope === ALL_PROJECTS ? <NewCardButton targets={cardTargets} /> : null}
              {archiveTarget === null ? null : (
                <Button
                  label="Archived"
                  icon="archivebox"
                  tone="text"
                  onPress={() =>
                    navigation.navigate("SettingsKanbanArchive", {
                      environmentId: archiveTarget.environmentId,
                      boardId: archiveTarget.boardId,
                    })
                  }
                />
              )}
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
          </View>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
