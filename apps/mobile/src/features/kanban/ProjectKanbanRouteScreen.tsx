import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { selectKanbanColumns } from "@t3tools/client-runtime/state/kanban";
import {
  boardScopeKey,
  isWipExceeded,
  kanbanColor,
  kanbanSectionCollapsed,
  resolveKanbanPanelBoard,
  type KanbanPanelScope,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, KanbanColumnId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useKanbanStates } from "../../state/kanban";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { KanbanCardMenu } from "./KanbanCardMenu";
import { KanbanCardTile } from "./KanbanCardTile";
import { useCreateKanbanBoard, useCreateKanbanCard } from "./useCreateKanbanBoard";
import { useKanbanActions } from "./useKanbanActions";
import { useKanbanPanelPreferences } from "./useKanbanPanelPreferences";

type ProjectKanbanRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
};

/** A thread's project board: one folding section per column, like the web right panel. */
export function ProjectKanbanRouteScreen({ route }: StaticScreenProps<ProjectKanbanRouteParams>) {
  const { environmentId, projectId } = route.params;
  const navigation = useNavigation();
  const now = useNowMinuteMs();
  const entry = useKanbanStates().find((state) => state.environmentId === environmentId);
  const scratchRoot = useServerConfigs().get(environmentId)?.scratchWorkspaceRoot;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const project = projects.find((candidate) => candidate.id === projectId);
  const scratch = projects.find((candidate) => isScratchProject(candidate, scratchRoot));
  const preferences = useKanbanPanelPreferences();
  const scopeKey = boardScopeKey(environmentId, projectId);
  const threadIsScratch = project !== undefined && isScratchProject(project, scratchRoot);
  const state = entry?.state ?? null;
  const { scope, ownerId, board, createsOnView } = resolveKanbanPanelBoard({
    state,
    projectId,
    threadIsScratch,
    scratchProjectId: scratch?.id ?? null,
    savedScope: preferences.scopes[scopeKey],
  });
  const actions = useKanbanActions(environmentId);
  const ensureBoard = useCreateKanbanBoard();
  const createOnNewBoard = useCreateKanbanCard();

  const ensured = useRef(false);
  const shouldEnsure = createsOnView && actions.canEdit && state !== null && board === undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the project's board on the server the first time it is viewed, like web
  useEffect(() => {
    if (!shouldEnsure || ensured.current) return;
    ensured.current = true;
    void ensureBoard({ environmentId, projectId, key: scopeKey, title: "" });
  }, [shouldEnsure, ensureBoard, environmentId, projectId, scopeKey]);

  const addCard = (columnId: KanbanColumnId | null, columnName: string | null) =>
    Dialog.prompt({
      title: "New card",
      ...(columnName === null ? {} : { message: columnName }),
      placeholder: "Title",
      initialValue: "",
      confirmText: "Add",
      onConfirm: (value) => {
        const title = value.trim();
        if (title.length === 0) return;
        if (board === undefined) {
          void createOnNewBoard(
            { environmentId, projectId: ownerId, key: scopeKey, title: "" },
            title,
          );
          return;
        }
        void actions.createCard({
          boardId: board.id,
          title,
          ...(columnId === null ? {} : { columnId }),
        });
      },
    });

  const projectTitle = project?.title ?? "Project";
  const scopeTitle = scope === "project" ? projectTitle : "No project";
  const scopeActions = (["project", "no-project"] as const).map((option) => ({
    id: option,
    title: option === "project" ? projectTitle : "No project",
    state: scope === option ? ("on" as const) : ("off" as const),
  }));
  const canAdd = actions.canEdit && state !== null;

  const body = (() => {
    if (entry === undefined) {
      return (
        <EmptyState
          variant="plain"
          title="Boards are not available"
          detail="This environment does not support boards, or you cannot read them."
        />
      );
    }
    if (entry.error) {
      return (
        <EmptyState
          variant="plain"
          title="Could not load the board"
          detail="The environment did not return its boards. Try again when it reconnects."
        />
      );
    }
    if (state === null) {
      return (
        <EmptyState variant="plain" title="Loading board…" detail="Connecting to the board." />
      );
    }
    if (board === undefined) {
      if (createsOnView) {
        return actions.canEdit ? (
          <EmptyState variant="plain" title="Setting up the board…" detail="One moment." />
        ) : (
          <EmptyState
            variant="plain"
            title="No board yet"
            detail="This project has no board, and you cannot create one here."
          />
        );
      }
      return (
        <EmptyState
          variant="plain"
          title="No cards without a project"
          detail="Cards you add here belong to no project."
        />
      );
    }
    const collapsedColumns = preferences.collapsed[board.id];
    return selectKanbanColumns(board).map(({ column, cards }) => {
      const collapsed = kanbanSectionCollapsed(column, collapsedColumns);
      const count =
        column.wipLimit === null ? String(cards.length) : `${cards.length}/${column.wipLimit}`;
      return (
        <View key={column.id} className="gap-2">
          <View className="flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${column.name}, ${cards.length} ${cards.length === 1 ? "card" : "cards"}`}
              accessibilityState={{ expanded: !collapsed }}
              onPress={() => preferences.setCollapsed(board.id, column.id, !collapsed)}
              className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
            >
              <SymbolView
                name={collapsed ? "chevron.right" : "chevron.down"}
                size={11}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
              {column.color ? (
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
                {column.name}
              </Text>
              <Text
                textRole="footnote"
                className={
                  isWipExceeded(column, cards.length)
                    ? "text-danger-foreground"
                    : "text-foreground-muted"
                }
              >
                {count}
              </Text>
            </Pressable>
            {canAdd ? (
              <IconButton
                accessibilityLabel={`Add a card to ${column.name}`}
                icon="plus"
                onPress={() => addCard(column.id, column.name)}
              />
            ) : null}
          </View>
          {collapsed
            ? null
            : cards.map((card) => {
                const open = () =>
                  navigation.navigate("SettingsKanbanCard", { environmentId, cardId: card.id });
                return (
                  <KanbanCardMenu
                    key={card.id}
                    environmentId={environmentId}
                    board={board}
                    card={card}
                    onOpen={open}
                  >
                    <KanbanCardTile
                      card={card}
                      board={board}
                      now={now}
                      onPress={open}
                      accessory={
                        actions.canEdit ? (
                          <KanbanCardMenu
                            environmentId={environmentId}
                            board={board}
                            card={card}
                            onOpen={open}
                            openOnPress
                          >
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Actions for #${card.number}`}
                              hitSlop={10}
                              className="-my-1 size-7 items-center justify-center rounded-full active:opacity-70"
                            >
                              <SymbolView
                                name="ellipsis"
                                size={15}
                                tintColorClassName="accent-icon-muted"
                                type="monochrome"
                              />
                            </Pressable>
                          </KanbanCardMenu>
                        ) : null
                      }
                    />
                  </KanbanCardMenu>
                );
              })}
          {!collapsed && cards.length === 0 ? (
            <Text textRole="footnote" className="pb-2 pl-5 text-foreground-muted">
              No cards
            </Text>
          ) : null}
        </View>
      );
    });
  })();

  return (
    <SettingsScreen
      title="Board"
      actions={[
        ...(canAdd
          ? [
              {
                accessibilityLabel: "New card",
                icon: "plus" as const,
                onPress: () => addCard(null, null),
              },
            ]
          : []),
        {
          accessibilityLabel: "Open the full board",
          icon: "square.grid.2x2" as const,
          onPress: () =>
            navigation.navigate("SettingsKanban", {
              scope: boardScopeKey(environmentId, board?.projectId ?? ownerId ?? projectId),
            }),
        },
      ]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-4 pb-10 pt-3"
      >
        {threadIsScratch ? (
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            No project
          </Text>
        ) : (
          <View className="flex-row">
            <Menu
              actions={scopeActions}
              onPressAction={({ nativeEvent }) =>
                preferences.setScope(scopeKey, nativeEvent.event as KanbanPanelScope)
              }
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Choose board"
                className="min-h-9 flex-row items-center gap-2 rounded-full bg-secondary px-4 active:opacity-70"
              >
                <Text
                  textRole="footnote"
                  numberOfLines={1}
                  className="font-t3-medium text-foreground"
                >
                  {scopeTitle}
                </Text>
                <SymbolView name="chevron.down" size={12} tintColorClassName="accent-chevron" />
              </Pressable>
            </Menu>
          </View>
        )}
        {body}
      </ScrollView>
    </SettingsScreen>
  );
}
