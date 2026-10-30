import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { defaultWorkProject, workProjectOptions } from "@t3tools/client-runtime/notes/work";
import { selectKanbanBoardByProject } from "@t3tools/client-runtime/state/kanban";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type KanbanColumnId,
  type NoteCardLink,
  type ProjectId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useProjects, useThreadShells } from "../../state/entities";
import { useKanbanStates } from "../../state/kanban";
import { notesEnvironment } from "../../state/notes";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { notesError } from "./delivery";
import { NoteCardSection } from "./NoteCard";
import { notesCommandOptions, useNoteDraftAccess } from "./notes-state";

const DEFAULT_COLUMN = "";

/** Creates one kanban card from the note in a chosen project, then offers to open it or start an agent. */
export function NoteStartWorkRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; path: string; another?: boolean }>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const { path } = route.params;
  // The note already has a card: this creates a second one and links the note to it.
  const another = route.params.another === true;
  const { canAct } = useNoteDraftAccess(environmentId);
  const startWork = useAtomCommand(notesEnvironment.startWork, notesCommandOptions);
  // One id per screen: a retry after a lost response returns the card instead of a second one.
  const [requestId] = useState(uuidv4);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const recent = useThreadShells()
    .filter((thread) => thread.environmentId === environmentId)
    .sort((left, right) =>
      (right.latestUserMessageAt ?? right.updatedAt).localeCompare(
        left.latestUserMessageAt ?? left.updatedAt,
      ),
    )
    .map((thread) => thread.projectId);
  const folder = path.includes("/") ? path.split("/")[0]! : null;
  const [pickedProject, setPickedProject] = useState<ProjectId | null>(null);
  const projectId = pickedProject ?? defaultWorkProject(projects, folder, recent);
  const [columnId, setColumnId] = useState<string>(DEFAULT_COLUMN);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<NoteCardLink | null>(null);
  usePreventRemove(busy, () => undefined);

  const kanban = useKanbanStates().find((entry) => entry.environmentId === environmentId)?.state;
  const board =
    kanban && projectId !== null ? selectKanbanBoardByProject(kanban, projectId) : undefined;
  const columns = board?.columns ?? [];
  const options = workProjectOptions(projects);
  // A retry must carry the same choice as the attempt whose response may have been lost.
  const frozen = busy || attempted;

  const start = async () => {
    if (busy || projectId === null || !canAct) return;
    setBusy(true);
    setAttempted(true);
    setError(null);
    const result = await startWork({
      environmentId,
      input: {
        path,
        projectId,
        requestId,
        ...(another ? { forceNew: true } : {}),
        ...(columnId === DEFAULT_COLUMN ? {} : { columnId: columnId as KanbanColumnId }),
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setStarted({ cardId: result.value.cardId, projectId });
    } else if (AsyncResult.isFailure(result)) {
      setError(notesError(squashAtomCommandFailure(result)));
    }
  };

  if (started) {
    return (
      <SettingsScreen title="Card created">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 p-5"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <Text className="text-foreground-muted">
            The note is now linked to its card. Open the card, or start an agent on it right away.
          </Text>
          <NoteCardSection environmentId={environmentId} link={started} />
          <Button label="Done" tone="primary" onPress={() => navigation.goBack()} />
        </ScrollView>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title={another ? "Start another card" : "Start work"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <Text className="text-foreground-muted">
          Creates a card from this note on the project’s board, with the note as its description,
          and links the two.
        </Text>
        {projectId === null ? (
          <Text className="text-foreground-muted">No projects in this environment yet.</Text>
        ) : (
          <Picker
            label="Project"
            value={options.find((option) => option.value === projectId)?.label ?? "Project"}
            disabled={frozen}
            actions={options.map((option) => ({
              id: option.value,
              title: option.label,
              state: option.value === projectId ? ("on" as const) : ("off" as const),
            }))}
            onSelect={(id) => {
              setPickedProject(id as ProjectId);
              setColumnId(DEFAULT_COLUMN);
            }}
          />
        )}
        {columns.length > 0 ? (
          <Picker
            label="Column"
            value={columns.find((column) => column.id === columnId)?.name ?? "Default column"}
            disabled={frozen}
            actions={[
              {
                id: DEFAULT_COLUMN,
                title: "Default column",
                state: columnId === DEFAULT_COLUMN ? ("on" as const) : ("off" as const),
              },
              ...columns.map((column) => ({
                id: column.id,
                title: column.name,
                state: column.id === columnId ? ("on" as const) : ("off" as const),
              })),
            ]}
            onSelect={setColumnId}
          />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {error}
          </Text>
        ) : null}
        <Button
          label={attempted && !busy ? "Try again" : another ? "Create card" : "Start work"}
          icon="sparkles"
          tone="primary"
          loading={busy}
          disabled={projectId === null || !canAct}
          onPress={() => void start()}
        />
      </ScrollView>
    </SettingsScreen>
  );
}

function Picker(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly actions: ReadonlyArray<{ id: string; title: string; state: "on" | "off" }>;
  readonly onSelect: (id: string) => void;
}) {
  const trigger = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.value}`}
      disabled={props.disabled}
      className="min-h-11 flex-row items-center gap-2 rounded-xl bg-grouped-card px-4 active:opacity-70"
    >
      <Text textRole="footnote" className="text-foreground-muted">
        {props.label}
      </Text>
      <Text
        textRole="footnote"
        numberOfLines={1}
        className="min-w-0 flex-1 font-t3-medium text-foreground"
      >
        {props.value}
      </Text>
      {props.disabled ? null : (
        <SymbolView name="chevron.down" size={12} tintColorClassName="accent-chevron" />
      )}
    </Pressable>
  );
  return props.disabled ? (
    <View>{trigger}</View>
  ) : (
    <Menu
      actions={[...props.actions]}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      {trigger}
    </Menu>
  );
}
