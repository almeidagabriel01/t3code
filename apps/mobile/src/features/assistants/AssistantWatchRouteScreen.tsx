// @effect-diagnostics globalDate:off - The expiry is a local date and time the picker hands back.
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import {
  AUTONOMY_WATCH_EVENT_LABELS,
  AUTONOMY_WATCH_PR_EVENTS,
  localDateTimeString,
  watchInputFromDraft,
} from "@t3tools/client-runtime/autonomy";
import {
  AUTONOMY_WATCH_EVENTS,
  AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH,
  type AutonomyWatchEvent,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useRef, useState } from "react";
import { Keyboard, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAutonomyWatchActions } from "../../state/autonomy";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { formatRunAtDate, formatRunAtTime } from "../settings/scheduledTaskPresentation";
import { ChoiceRow, FieldHeader, MenuField, SwitchRow, TextField } from "./AssistantFormFields";
import {
  assistantWatchDraftHasChanges,
  assistantWatchEditorAtom,
  discardAssistantWatchEditor,
  updateAssistantWatchDraft,
  type AssistantWatchEditor,
} from "./assistantWatchEditor";

const ALL_PROJECTS = "all";
const DAY_MS = 24 * 60 * 60 * 1000;

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.value}`}
      onPress={props.onPress}
      className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle bg-grouped-card px-4 py-3 active:opacity-70"
    >
      <Text textRole="body" className="text-foreground">
        {props.label}
      </Text>
      <Text textRole="footnote" className="min-w-0 flex-1 text-right text-foreground-muted">
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

export function AssistantWatchRouteScreen() {
  const editor = useAtomValue(assistantWatchEditorAtom);
  if (!editor) {
    return (
      <SettingsScreen title="Watch">
        <Text className="p-5 text-base text-foreground-muted">Open a watch first.</Text>
      </SettingsScreen>
    );
  }
  return <WatchForm editor={editor} />;
}

function WatchForm(props: { readonly editor: AssistantWatchEditor }) {
  const { editor } = props;
  const { current: draft, environmentId, assistantId, projects } = editor;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const actions = useAutonomyWatchActions(environmentId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  // Set once the save or delete lands, so the removal guard lets the form close.
  const closing = useRef(false);

  const hasChanges = assistantWatchDraftHasChanges(editor);
  const preventRemove = hasChanges || saving;
  const close = () => {
    closing.current = true;
    navigation.goBack();
    discardAssistantWatchEditor();
  };
  usePreventRemove(preventRemove, ({ data }) => {
    if (closing.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert("Saving", "Wait for the watch to finish saving before leaving.");
      return;
    }
    Keyboard.dismiss();
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => {
          closing.current = true;
          discardAssistantWatchEditor();
          navigation.dispatch(data.action);
        },
      },
    ]);
  });

  const save = async () => {
    const built = watchInputFromDraft(assistantId, draft);
    if (!built.ok) return setError(built.message);
    setError(null);
    setSaving(true);
    const reply = await actions.save(built.input);
    setSaving(false);
    if (reply.ok) close();
    else setError(reply.message);
  };
  const remove = () => {
    if (draft.id === null) return;
    const id = draft.id;
    Dialog.confirm({
      title: `Delete the watch "${draft.title}"?`,
      message: "It stops immediately.",
      confirmText: "Delete",
      onConfirm: () => {
        void (async () => {
          const reply = await actions.remove(id);
          if (reply.ok) close();
          else Dialog.alert("Could not delete the watch", reply.message);
        })();
      },
    });
  };

  const projectLabel =
    projects.find((project) => project.id === draft.projectId)?.label ?? "All projects";
  const projectActions: MenuAction[] = [
    { id: ALL_PROJECTS, title: "All projects", state: draft.projectId === null ? "on" : "off" },
    ...projects.map((project) => ({
      id: project.id,
      title: project.label,
      state: project.id === draft.projectId ? ("on" as const) : ("off" as const),
    })),
  ];
  const eventActions: MenuAction[] = AUTONOMY_WATCH_EVENTS.map((event) => ({
    id: event,
    title: AUTONOMY_WATCH_EVENT_LABELS[event],
    state: event === draft.event ? "on" : "off",
  }));
  const expires = draft.expiresAt === "" ? null : new Date(draft.expiresAt);

  return (
    <SettingsScreen title={draft.id === null ? "New watch" : "Edit watch"}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            // Native Back pops before removal guards; a bar action lets the guard run first.
            unstable_headerLeftItems: () => [
              withNativeGlassHeaderItem({
                type: "button",
                label: "",
                accessibilityLabel: "Back",
                icon: { type: "sfSymbol", name: "chevron.backward" },
                onPress: () => navigation.goBack(),
              }),
            ],
          }}
        />
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <TextField
          label="Title"
          description="How the watch is listed."
          placeholder="Review finished runs"
          value={draft.title}
          maxLength={120}
          autoCapitalize="sentences"
          onChange={(title) => updateAssistantWatchDraft({ title })}
        />
        <MenuField
          label="Wake it when"
          description="The event that wakes the assistant."
          value={AUTONOMY_WATCH_EVENT_LABELS[draft.event]}
          actions={eventActions}
          onSelect={(event) => updateAssistantWatchDraft({ event: event as AutonomyWatchEvent })}
        />
        <MenuField
          label="Project"
          description="Only events in this project count."
          value={projectLabel}
          actions={projectActions}
          onSelect={(id) =>
            updateAssistantWatchDraft({ projectId: id === ALL_PROJECTS ? null : (id as ProjectId) })
          }
        />
        {AUTONOMY_WATCH_PR_EVENTS.includes(draft.event) ? (
          <TextField
            label="PR number"
            description="Leave empty to watch any pull request."
            value={draft.prNumber}
            keyboardType="number-pad"
            autoCapitalize="none"
            onChange={(prNumber) => updateAssistantWatchDraft({ prNumber })}
          />
        ) : null}
        <TextField
          label="What it should do"
          description="For example: check that the agent did everything it was asked and tell me what it missed."
          value={draft.instruction}
          maxLength={AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH}
          multiline
          autoCapitalize="sentences"
          onChange={(instruction) => updateAssistantWatchDraft({ instruction })}
        />
        <View className="gap-2">
          <FieldHeader label="Expires" description="When the watch stops on its own." />
          <ListSection>
            <ChoiceRow
              role="radio"
              icon="eye"
              label="Keep watching"
              selected={expires === null}
              onPress={() => {
                setPicker(null);
                updateAssistantWatchDraft({ expiresAt: "" });
              }}
            />
            <ChoiceRow
              role="radio"
              icon="calendar"
              label="Stop on a date"
              selected={expires !== null}
              onPress={() =>
                expires === null
                  ? updateAssistantWatchDraft({
                      expiresAt: localDateTimeString(new Date(Date.now() + DAY_MS)),
                    })
                  : undefined
              }
            />
            {expires === null ? null : (
              <>
                <PickerRow
                  label="Date"
                  value={formatRunAtDate(expires)}
                  onPress={() => setPicker((open) => (open === "date" ? null : "date"))}
                />
                <PickerRow
                  label="Time"
                  value={formatRunAtTime(expires)}
                  onPress={() => setPicker((open) => (open === "time" ? null : "time"))}
                />
                {picker === null ? null : (
                  <DateTimePicker
                    value={expires}
                    mode={picker}
                    display={Platform.OS === "ios" ? "spinner" : "default"}
                    onDismiss={() => setPicker(null)}
                    onValueChange={(_, selected) => {
                      // Android shows a dialog that closes on pick; iOS stays inline.
                      if (Platform.OS === "android") setPicker(null);
                      updateAssistantWatchDraft({ expiresAt: localDateTimeString(selected) });
                    }}
                  />
                )}
              </>
            )}
          </ListSection>
        </View>
        <ListSection footer="Stops the watch after the first time it wakes the assistant.">
          <SwitchRow
            icon="target"
            label="Only once"
            value={draft.oneShot}
            onChange={(oneShot) => updateAssistantWatchDraft({ oneShot })}
          />
        </ListSection>
        {error ? (
          <Text
            accessibilityRole="alert"
            textRole="footnote"
            className="px-2 text-danger-foreground"
          >
            {error}
          </Text>
        ) : null}
        <Button
          label="Save watch"
          tone="primary"
          fullWidth
          loading={saving}
          disabled={saving || !actions.canAct || (draft.id !== null && !hasChanges)}
          onPress={() => void save()}
        />
        {draft.id === null ? null : (
          <ListSection title="Manage">
            <ListActionRow
              icon="trash"
              tone="danger"
              label="Delete watch"
              description="It stops immediately."
              disabled={!actions.canAct || saving}
              onPress={remove}
            />
          </ListSection>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
