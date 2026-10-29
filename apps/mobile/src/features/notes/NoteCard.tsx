import {
  selectKanbanBoardByProject,
  type KanbanBoardState,
} from "@t3tools/client-runtime/state/kanban";
import type { EnvironmentId, KanbanCard, NoteCardLink } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { useKanbanStates } from "../../state/kanban";
import { useStartKanbanAgent } from "../kanban/useStartKanbanAgent";

export type NoteCardState =
  | { readonly status: "loading" | "unavailable" | "removed" }
  | {
      readonly status: "found";
      readonly board: KanbanBoardState;
      readonly card: KanbanCard;
      readonly columnName: string | null;
    };

/** The kanban card a note links to, read from the board's live state. */
export function useNoteCard(
  environmentId: EnvironmentId,
  link: NoteCardLink | null,
): NoteCardState {
  const entry = useKanbanStates().find((state) => state.environmentId === environmentId);
  if (entry === undefined) return { status: "unavailable" };
  if (link === null) return { status: "removed" };
  if (entry.state === null || entry.state.sequence === null) return { status: "loading" };
  const board = selectKanbanBoardByProject(entry.state, link.projectId);
  const card = board?.cards.get(link.cardId);
  if (board === undefined || card === undefined) return { status: "removed" };
  return {
    status: "found",
    board,
    card,
    columnName: board.columns.find((column) => column.id === card.columnId)?.name ?? null,
  };
}

/** The note's card: number, title and column, with open, start agent and unlink. */
export function NoteCardSection(props: {
  readonly environmentId: EnvironmentId;
  readonly link: NoteCardLink;
  readonly onUnlink?: () => void;
}) {
  const state = useNoteCard(props.environmentId, props.link);
  return (
    <View className="gap-2">
      <NoteCardChip environmentId={props.environmentId} state={state} />
      <View className="flex-row flex-wrap gap-2">
        {state.status === "found" ? (
          <StartAgentButton
            environmentId={props.environmentId}
            board={state.board}
            card={state.card}
          />
        ) : null}
        {props.onUnlink ? (
          <Button label="Unlink" icon="link" tone="text" onPress={props.onUnlink} />
        ) : null}
      </View>
    </View>
  );
}

export function NoteCardChip(props: {
  readonly environmentId: EnvironmentId;
  readonly state: NoteCardState;
}) {
  const navigation = useNavigation();
  const { state } = props;
  if (state.status === "loading") {
    return (
      <Text textRole="footnote" className="text-foreground-muted">
        Loading the card…
      </Text>
    );
  }
  if (state.status !== "found") {
    return (
      <View className="min-h-11 flex-row items-center gap-2 rounded-xl bg-secondary px-3">
        <SymbolView name="square.grid.2x2" size={14} tintColorClassName="accent-icon-muted" />
        <Text textRole="footnote" className="text-foreground-muted">
          {state.status === "unavailable" ? "Board unavailable here" : "Card removed"}
        </Text>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open card #${state.card.number}, ${state.card.title}`}
      onPress={() =>
        navigation.navigate("SettingsKanbanCard", {
          environmentId: props.environmentId,
          cardId: state.card.id,
        })
      }
      className="min-h-11 flex-row items-center gap-2 rounded-xl bg-secondary px-3 py-2 active:opacity-70"
    >
      <SymbolView name="square.grid.2x2" size={14} tintColorClassName="accent-icon-muted" />
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        #{state.card.number}
      </Text>
      <Text textRole="footnote" numberOfLines={1} className="min-w-0 flex-1 text-foreground">
        {state.card.title}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {state.card.archivedAt !== null ? "Archived" : (state.columnName ?? "")}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-chevron" />
    </Pressable>
  );
}

function StartAgentButton(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly card: KanbanCard;
}) {
  const agent = useStartKanbanAgent(props.environmentId, props.board, props.card);
  return (
    <Button
      label="Start agent"
      icon="sparkles"
      tone="secondary"
      loading={agent.starting}
      disabled={!agent.ready}
      onPress={() => void agent.start()}
    />
  );
}
