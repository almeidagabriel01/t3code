import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { diffNoteLines, type NoteDiffLine } from "@t3tools/client-runtime/notes/line-diff";
import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { notesError } from "./delivery";
import { flushNotes, notesOutbox, useNoteDraftAccess, useNotesOutbox } from "./notes-state";

export function NoteConflictRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; path: string }>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const row = useNotesOutbox().find(
    (entry) => entry.environmentId === environmentId && entry.path === route.params.path,
  );
  const diff = diffNoteLines(row?.body ?? "", row?.current?.body ?? "");
  const { canEdit } = useNoteDraftAccess(environmentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (choice: "mine" | "theirs") => {
    setPending(true);
    try {
      await notesOutbox.resolve(environmentId, route.params.path, choice);
      void flushNotes(environmentId).catch((cause: unknown) =>
        console.warn("[notes] sync failed", cause),
      );
      navigation.goBack();
    } catch (cause) {
      setError(notesError(cause));
    }
    setPending(false);
  };
  if (row?.state !== "conflict" || row.current === null) {
    return (
      <SettingsScreen title="Compare versions">
        <EmptyState variant="plain" title="Nothing to compare" detail="This note is in sync." />
      </SettingsScreen>
    );
  }
  return (
    <SettingsScreen title="Compare versions">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="gap-1">
          <Text textRole="footnote" className="text-foreground-muted">
            + Added on this device · − Only in the saved version
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            Keep mine can conflict again if the note changes once more.
            {diff.wholeBlock ? " Large note: comparing whole versions." : ""}
          </Text>
        </View>
        <NoteVersion title="On this device" lines={diff.local} />
        <NoteVersion title="Saved version" lines={diff.server} />
        {error ? (
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {error}
          </Text>
        ) : null}
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              fullWidth
              label="Use theirs"
              tone="secondary"
              disabled={pending}
              onPress={() => void resolve("theirs")}
            />
          </View>
          <View className="flex-1">
            <Button
              fullWidth
              label="Keep mine"
              tone="primary"
              disabled={pending || !canEdit}
              onPress={() => void resolve("mine")}
            />
          </View>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function NoteVersion(props: {
  readonly title: string;
  readonly lines: ReadonlyArray<NoteDiffLine>;
}) {
  // Stateless rows keyed by position: blank and repeated lines have identical text.
  // oxlint-disable react/no-array-index-key
  return (
    <View className="overflow-hidden rounded-2xl bg-grouped-card">
      <Text
        accessibilityRole="header"
        textRole="footnote"
        className="px-4 pt-3 pb-1 font-t3-medium text-foreground-muted"
      >
        {props.title}
      </Text>
      <View className="pb-3">
        {props.lines.length === 0 ? (
          <Text className="px-4 text-foreground-muted">Empty note</Text>
        ) : (
          props.lines.map((line, index) => (
            <Text
              key={index}
              selectable
              className={
                line.kind === "added"
                  ? "bg-emerald-500/10 px-4 py-0.5 font-mono text-sm text-foreground"
                  : line.kind === "removed"
                    ? "bg-rose-500/10 px-4 py-0.5 font-mono text-sm text-foreground"
                    : "px-4 py-0.5 font-mono text-sm text-foreground"
              }
            >
              {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
              {line.text || " "}
            </Text>
          ))
        )}
      </View>
    </View>
  );
  // oxlint-enable react/no-array-index-key
}
