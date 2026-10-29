import { useNavigation } from "@react-navigation/native";
import { selectNotesInOrder } from "@t3tools/client-runtime/state/notes";
import { NotePath, type EnvironmentId } from "@t3tools/contracts";
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
import { useNotesEnvironmentIds, useNotesFeed } from "../../state/notes";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { notesError } from "./delivery";
import { newNotePath, noteListRows, noteSyncLabel, type NoteListRow } from "./notes-model";
import { useNoteDraftAccess, useNotesOutbox } from "./notes-state";

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
  const rows = noteListRows(environmentId, state ? selectNotesInOrder(state) : [], outbox);
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
        } else if (rows.some((row) => row.path === path)) {
          navigation.navigate("SettingsNote", { environmentId, path });
        } else {
          navigation.navigate("SettingsNote", { environmentId, path, create: true });
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
            Showing the most recent notes only.
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
                  row={row}
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

function NoteRow(props: { readonly row: NoteListRow; readonly onPress: () => void }) {
  const { row } = props;
  const sync = noteSyncLabel(row.sync);
  return (
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
