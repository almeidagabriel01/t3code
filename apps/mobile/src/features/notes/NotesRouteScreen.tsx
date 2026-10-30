import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { selectNotesInOrder } from "@t3tools/client-runtime/state/notes";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { NotePath, type EnvironmentId, type NoteSummary, type ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { notesEnvironment, useNotesEnvironmentIds, useNotesFeed } from "../../state/notes";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { NoteProjectPicker } from "./NoteProjectPicker";
import { notesError } from "./delivery";
import {
  newNotePath,
  noteListRows,
  noteRowMenuActions,
  noteSyncLabel,
  type NoteListRow,
  type NoteRowActionId,
} from "./notes-model";
import { notesCommandOptions, useNoteDraftAccess, useNotesOutbox } from "./notes-state";

const isNotePath = Schema.is(NotePath);

export function NotesRouteScreen() {
  const environmentIds = useNotesEnvironmentIds();
  const environments = useWorkspaceEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId = environmentIds.find((id) => id === selected) ?? environmentIds[0] ?? null;
  const label = (id: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === id)?.environmentLabel ?? "Environment";
  if (environmentId === null) {
    return (
      <SettingsScreen title="Notes">
        <EmptyState
          variant="plain"
          title="No notes here"
          detail="None of your environments supports notes. Update T3 Code on your computer."
        />
      </SettingsScreen>
    );
  }
  return (
    <EnvironmentNotes
      key={environmentId}
      environmentId={environmentId}
      picker={
        environmentIds.length > 1 ? (
          <Menu
            actions={environmentIds.map((id) => ({
              id,
              title: label(id),
              state: id === environmentId ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => setSelected(nativeEvent.event as EnvironmentId)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose environment"
              className="min-h-9 flex-row items-center gap-2 self-start rounded-full bg-secondary px-4 active:opacity-70"
            >
              <Text
                textRole="footnote"
                numberOfLines={1}
                className="font-t3-medium text-foreground"
              >
                {label(environmentId)}
              </Text>
              <SymbolView name="chevron.down" size={12} tintColorClassName="accent-chevron" />
            </Pressable>
          </Menu>
        ) : null
      }
    />
  );
}

function EnvironmentNotes(props: {
  readonly environmentId: EnvironmentId;
  readonly picker: React.ReactNode;
}) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const feed = useNotesFeed(environmentId);
  const outbox = useNotesOutbox();
  const { canEdit, connected } = useNoteDraftAccess(environmentId);
  const state = Option.getOrNull(AsyncResult.value(feed));
  const [project, setProject] = useState<ProjectId | null>(null);
  const allRows = noteListRows(environmentId, state ? selectNotesInOrder(state) : [], outbox);
  const rows = project === null ? allRows : allRows.filter((row) => row.project === project);
  const groups = groupRows(rows);

  const create = () =>
    Dialog.prompt({
      title: "New note",
      message: "Name it, or put it in a folder with folder/name.",
      placeholder: "Untitled",
      initialValue: "",
      confirmText: "Create",
      onConfirm: (value) => {
        const path = newNotePath(value.trim() || "Untitled");
        if (!isNotePath(path)) {
          Dialog.alert(
            "Can't use that name",
            "Use a name or folder/name without slashes beyond one folder, leading dots, or colons.",
          );
        } else if (allRows.some((row) => row.path === path)) {
          navigation.navigate("SettingsNote", { environmentId, path });
        } else {
          navigation.navigate("SettingsNote", {
            environmentId,
            path,
            create: true,
            ...(project === null ? {} : { project }),
          });
        }
      },
    });

  return (
    <SettingsScreen
      title="Notes"
      actions={
        canEdit
          ? [{ accessibilityLabel: "New note", icon: "square.and.pencil", onPress: create }]
          : []
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 p-4"
      >
        {props.picker}
        <NoteProjectPicker
          environmentId={environmentId}
          value={project}
          noneLabel="All projects"
          accessibilityLabel="Filter by project"
          onChange={setProject}
        />
        {!connected ? (
          <Text textRole="footnote" className="text-foreground-muted">
            Offline. Edits save on this device and sync when you reconnect.
          </Text>
        ) : null}
        {AsyncResult.isFailure(feed) ? (
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {notesError(Cause.squash(feed.cause))} Saved edits stay on this device.
          </Text>
        ) : null}
        {state?.truncated ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {state.omitted > 0
              ? `${state.omitted} more notes are not shown.`
              : "More notes are not shown."}
          </Text>
        ) : null}
        {state && state.skipped.length > 0 ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {`${state.skipped.length} ${state.skipped.length === 1 ? "file is" : "files are"} not shown as notes: ${state.skipped.map((entry) => entry.name).join(", ")}`}
          </Text>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState
            variant="plain"
            title={state ? "No notes yet" : connected ? "Loading notes" : "Not loaded"}
            detail={
              state
                ? "Notes you or your agents write show up here."
                : connected
                  ? "Connecting to your environment."
                  : "Connect to this environment to load its notes."
            }
          />
        ) : (
          groups.map(([group, entries]) => (
            <ListSection key={group} title={group}>
              {entries.map((row) => (
                <NoteRow
                  key={row.path}
                  environmentId={environmentId}
                  row={row}
                  summary={state?.notes.get(row.path)}
                  onPress={() =>
                    navigation.navigate("SettingsNote", { environmentId, path: row.path })
                  }
                />
              ))}
            </ListSection>
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function NoteRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: NoteListRow;
  /** The server's copy; a note that exists only as a draft here has none, so no actions. */
  readonly summary: NoteSummary | undefined;
  readonly onPress: () => void;
}) {
  const { environmentId, row, summary } = props;
  const navigation = useNavigation();
  const { canAct } = useNoteDraftAccess(environmentId);
  const canUpdate = useAtomValue(notesEnvironment.update.permissionAtom(environmentId));
  const canMove = useAtomValue(notesEnvironment.move.permissionAtom(environmentId));
  const canDelete = useAtomValue(notesEnvironment.delete.permissionAtom(environmentId));
  const canStart = useAtomValue(notesEnvironment.startWork.permissionAtom(environmentId));
  const update = useAtomCommand(notesEnvironment.update, notesCommandOptions);
  const move = useAtomCommand(notesEnvironment.move, notesCommandOptions);
  const remove = useAtomCommand(notesEnvironment.delete, notesCommandOptions);
  const sync = noteSyncLabel(row.sync);
  // A pending draft would conflict with a header or file change made on the server.
  const actions =
    summary !== undefined && canAct && row.sync === "synced"
      ? noteRowMenuActions(summary, {
          update: canUpdate,
          start: canStart,
          move: canMove,
          delete: canDelete,
        })
      : [];
  const fail = (result: AsyncResult.AsyncResult<unknown, unknown>) => {
    if (AsyncResult.isFailure(result))
      Dialog.alert("Couldn't change the note", notesError(squashAtomCommandFailure(result)));
  };
  const run = (id: NoteRowActionId) => {
    if (summary === undefined) return;
    if (id === "pin") {
      void update({ environmentId, input: { path: summary.path, pinned: !summary.pinned } }).then(
        fail,
      );
    } else if (id === "start") {
      navigation.navigate("SettingsNoteStartWork", {
        environmentId,
        path: summary.path,
        ...(summary.card === null ? {} : { another: true }),
      });
    } else if (id === "move") {
      Dialog.prompt({
        title: "Rename or move",
        message: "A file name, optionally inside one folder: folder/name.md",
        placeholder: "name.md",
        initialValue: summary.path,
        confirmText: "Move",
        onConfirm: (value) => {
          const to = value.trim().normalize("NFC");
          if (!isNotePath(to)) {
            Dialog.alert(
              "Can't use that name",
              "Use name.md or folder/name.md, at most one folder deep.",
            );
          } else if (to !== summary.path) {
            void move({
              environmentId,
              input: { from: summary.path, to, baseRevision: summary.revision },
            }).then(fail);
          }
        },
      });
    } else {
      Dialog.confirm({
        title: `Delete “${summary.title}”?`,
        message: `This removes ${summary.path} and its images.`,
        confirmText: "Delete",
        destructive: true,
        onConfirm: () =>
          void remove({
            environmentId,
            input: { path: summary.path, baseRevision: summary.revision },
          }).then(fail),
      });
    }
  };
  const content = (
    <NavigationRow
      className="bg-grouped-card"
      title={row.title}
      subtitle={[sync, row.preview || null].filter(Boolean).join(" · ") || null}
      leading={
        row.sync === "conflict" ? (
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
        ) : row.pinned ? (
          <SymbolView name="pin" size={16} tintColorClassName="accent-icon-muted" />
        ) : (
          <SymbolView name="doc.text" size={16} tintColorClassName="accent-icon-muted" />
        )
      }
      onPress={props.onPress}
    />
  );
  return actions.length === 0 ? (
    content
  ) : (
    <Menu
      actions={actions}
      onPressAction={({ nativeEvent }) => run(nativeEvent.event as NoteRowActionId)}
      shouldOpenOnLongPress
    >
      {content}
    </Menu>
  );
}

function groupRows(rows: ReadonlyArray<NoteListRow>) {
  const groups: Array<[string, NoteListRow[]]> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last[0] === row.group) last[1].push(row);
    else groups.push([row.group, [row]]);
  }
  return groups;
}
