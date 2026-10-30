import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProjectId, type NoteDocument } from "@t3tools/contracts";
import {
  attachmentImageMarkdown,
  parseAttachmentImageSrc,
} from "@t3tools/shared/attachmentImageRefs";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Linking, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { prepareTurnAttachments } from "../../lib/attachmentUpload";
import { pickComposerImages } from "../../lib/composerImages";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../../native/SelectableMarkdownText";
import { notesEnvironment, useNotesFeed } from "../../state/notes";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { ThreadMarkdownImage } from "../threads/ThreadMarkdownImage";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { notesError } from "./delivery";
import { applyNoteCheckboxEvent } from "./note-markdown";
import { NoteCardSection } from "./NoteCard";
import { noteSyncLabel, noteSyncState } from "./notes-model";
import {
  flushNotes,
  notesCommandOptions,
  notesOutbox,
  useNoteDraftAccess,
  useNotesOutbox,
} from "./notes-state";
import { NoteProjectPicker } from "./NoteProjectPicker";

type NoteParams = {
  environmentId: string;
  path: string;
  create?: boolean;
  project?: string;
};

export function NoteRouteScreen({ route }: StaticScreenProps<NoteParams>) {
  return (
    <NoteContent
      key={JSON.stringify([route.params.environmentId, route.params.path])}
      {...route.params}
    />
  );
}

function NoteContent(props: NoteParams) {
  const environmentId = EnvironmentId.make(props.environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const markdownStyles = useMarkdownPreviewStyles();
  const feed = useNotesFeed(environmentId);
  const row = useNotesOutbox().find(
    (entry) => entry.environmentId === environmentId && entry.path === props.path,
  );
  const { canEdit, canAct, connected } = useNoteDraftAccess(environmentId);
  const read = useAtomCommand(notesEnvironment.read, notesCommandOptions);
  const update = useAtomCommand(notesEnvironment.update, notesCommandOptions);
  const [note, setNote] = useState<NoteDocument | null>(row?.current ?? null);
  const [body, setBody] = useState(row?.body ?? "");
  // An acknowledgement can remove the outbox row while this editor still owns newer text.
  const [hasSnapshot, setHasSnapshot] = useState(Boolean(row) || Boolean(props.create));
  const [editing, setEditing] = useState(Boolean(props.create));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [checkboxRender, setCheckboxRender] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [expandedImage, setExpandedImage] = useState<FilePreviewSource | null>(null);
  const previousRow = useRef(row);
  const editBase = useRef<string | null>(row?.baseRevision ?? null);
  const localBody = useRef(body);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const pendingSaves = useRef(0);
  const latest = Option.getOrNull(AsyncResult.value(feed))?.notes.get(props.path);
  const latestRevision = latest?.revision;

  const adopt = useEffectEvent((document: NoteDocument) => {
    setHasSnapshot(true);
    setNote(document);
    setBody(document.body);
    localBody.current = document.body;
    editBase.current = document.revision;
  });

  usePreventRemove(dirty || saving || uploading, ({ data }) => {
    if (saving || uploading) return;
    Dialog.confirm({
      title: "Unsaved note",
      message: "Save your edits on this device before leaving, or discard them.",
      cancelText: "Keep editing",
      confirmText: "Discard edits",
      destructive: true,
      onConfirm: () => navigation.dispatch(data.action),
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this device's saved draft from SQLite once
  useEffect(() => {
    let active = true;
    void notesOutbox
      .restore()
      .then(() => {
        if (!active) return;
        setRestored(true);
        const saved = notesOutbox
          .getSnapshot()
          .find((entry) => entry.environmentId === environmentId && entry.path === props.path);
        if (saved) {
          setHasSnapshot(true);
          setBody(saved.body);
          localBody.current = saved.body;
          editBase.current = saved.baseRevision;
          if (saved.current) setNote(saved.current);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(notesError(cause));
      });
    return () => {
      active = false;
    };
  }, [environmentId, props.path]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the body from the server whenever its revision moves and no local draft owns the text
  useEffect(() => {
    if (!restored || !connected || row || editing || saving || dirty) return;
    if (props.create && latestRevision === undefined) return;
    let active = true;
    void read({ environmentId, input: { path: props.path } }).then((result) => {
      if (!active) return;
      if (AsyncResult.isSuccess(result)) {
        adopt(result.value);
        setError(null);
      } else if (AsyncResult.isFailure(result)) {
        setError(notesError(squashAtomCommandFailure(result)));
      }
    });
    return () => {
      active = false;
    };
  }, [
    environmentId,
    props.path,
    props.create,
    latestRevision,
    row,
    editing,
    saving,
    dirty,
    read,
    restored,
    connected,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- choosing "Use theirs" removes the draft, so the editor takes the server version it showed
  useEffect(() => {
    const before = previousRow.current;
    previousRow.current = row;
    if (before?.state === "conflict" && before.current && !row && !editing && !dirty && !saving)
      adopt(before.current);
  }, [row, editing, dirty, saving]);

  const save = async (nextBody: string) => {
    if (!canEdit) return;
    const createIn =
      props.create && props.project ? { project: ProjectId.make(props.project) } : {};
    setSaving(true);
    pendingSaves.current++;
    try {
      const stored = await notesOutbox.enqueue({
        environmentId,
        path: props.path,
        body: nextBody,
        baseRevision: editBase.current,
        ...createIn,
        localUpdatedAt: Date.now(),
      });
      setBody(stored);
      localBody.current = stored;
      setDirty(false);
      setEditing(false);
      setError(null);
      void flushNotes(environmentId).catch((cause: unknown) => setError(notesError(cause)));
    } catch (cause) {
      setDirty(true);
      setError(notesError(cause));
    }
    pendingSaves.current--;
    if (pendingSaves.current === 0) setSaving(false);
  };

  const edit = (value: string) => {
    setBody(value);
    localBody.current = value;
    setDirty(true);
  };

  const addImages = async () => {
    const picked = await pickComposerImages({ existingCount: 0 });
    if (picked.error) setError(picked.error);
    if (picked.images.length === 0) return;
    setUploading(true);
    const uploaded = await uploadNoteImages(environmentId, picked.images).then(
      (refs) => ({ refs, error: null }),
      (cause: unknown) => ({ refs: [], error: notesError(cause) }),
    );
    setUploading(false);
    if (uploaded.error) setError(uploaded.error);
    if (uploaded.refs.length === 0) return;
    const current = localBody.current;
    const at = selection.current?.end ?? current.length;
    const before = current.slice(0, at);
    const separator = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
    edit(`${before}${separator}${uploaded.refs.join("\n")}\n${current.slice(at)}`);
  };

  const runUpdate = async (input: {
    pinned?: boolean;
    card?: null;
    project?: ProjectId | null;
  }) => {
    setBusy(true);
    const result = await update({ environmentId, input: { path: props.path, ...input } });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      // Header-only change: the body is the same, the revision moves.
      setNote(result.value);
      editBase.current = result.value.revision;
      setError(null);
    } else if (AsyncResult.isFailure(result)) {
      setError(notesError(squashAtomCommandFailure(result)));
    }
  };

  const renderImage: MarkdownImageRenderer = (image) => {
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

  const conflicted = row?.state === "conflict";
  // Pin, unlink and start work rewrite the header on the server; a local draft would then conflict.
  const canChangeHeader = canAct && note !== null && !row && !editing && !dirty && !saving;
  const pinned = latest?.pinned ?? note?.pinned ?? false;
  const project = latest ? (latest.project ?? null) : (note?.project ?? null);
  const card = latest ? latest.card : (note?.card ?? null);
  const bodyAvailable = hasSnapshot || note !== null || row !== undefined;
  const status = saving
    ? "Saving on this device…"
    : uploading
      ? "Uploading images…"
      : dirty
        ? "Unsaved edits"
        : row
          ? noteSyncLabel(noteSyncState(row))
          : !restored
            ? "Loading saved edits…"
            : props.create && note === null
              ? "New note · save to create it"
              : !bodyAvailable
                ? "Not loaded"
                : !connected
                  ? "Offline · showing the last loaded version"
                  : null;
  const outboxError = notesOutbox.error(environmentId);

  return (
    <SettingsScreen
      title={note?.title ?? latest?.title ?? props.path.split("/").at(-1)!.slice(0, -".md".length)}
      actions={[
        {
          accessibilityLabel: pinned ? "Unpin note" : "Pin note",
          icon: pinned ? "pin.slash" : "pin",
          selected: pinned,
          disabled: !canChangeHeader || busy,
          onPress: () => void runUpdate({ pinned: !pinned }),
        },
      ]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="gap-1">
          <Text textRole="footnote" className="text-foreground-muted">
            {props.path}
          </Text>
          {status ? (
            <Text
              accessibilityLiveRegion="polite"
              textRole="footnote"
              className="text-foreground-muted"
            >
              {status}
            </Text>
          ) : null}
        </View>
        {error || outboxError ? (
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {error ?? outboxError}
          </Text>
        ) : null}
        {conflicted ? (
          <View className="gap-2 rounded-xl bg-secondary p-3">
            <Text textRole="footnote" className="text-foreground">
              This note changed elsewhere while you edited it here. Only this note waits; the rest
              keep syncing.
            </Text>
            <Button
              label="Compare versions"
              tone="primary"
              onPress={() =>
                navigation.navigate("SettingsNoteConflict", { environmentId, path: props.path })
              }
            />
          </View>
        ) : null}
        {row && !conflicted ? (
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Sync now"
              icon="arrow.clockwise"
              tone="text"
              disabled={!connected || saving}
              onPress={() =>
                void flushNotes(environmentId).catch((cause: unknown) =>
                  setError(notesError(cause)),
                )
              }
            />
            <Button
              label="Discard draft"
              icon="trash"
              tone="text"
              disabled={saving || Boolean(row.inFlight)}
              onPress={() =>
                Dialog.confirm({
                  title: "Discard this device's draft?",
                  message: "A version already saved on your computer stays as it is.",
                  confirmText: "Discard",
                  destructive: true,
                  onConfirm: () =>
                    void notesOutbox
                      .discard(environmentId, props.path, row.localUpdatedAt)
                      .then((removed) => {
                        if (!removed) {
                          setError("The draft changed or started syncing. Review it first.");
                        } else if (note === null) {
                          navigation.goBack();
                        } else {
                          setBody(note.body);
                          localBody.current = note.body;
                          editBase.current = note.revision;
                        }
                      })
                      .catch((cause: unknown) => setError(notesError(cause))),
                })
              }
            />
          </View>
        ) : null}

        {!bodyAvailable ? (
          <Text className="text-foreground-muted">
            Connect to this environment to open the note.
          </Text>
        ) : editing ? (
          <>
            <RNTextInput
              accessibilityLabel="Note markdown"
              multiline
              autoFocus
              textAlignVertical="top"
              value={body}
              editable={canEdit && !saving && restored}
              onChangeText={edit}
              onSelectionChange={(event) => {
                selection.current = event.nativeEvent.selection;
              }}
              placeholder="Write in markdown"
              placeholderTextColorClassName="accent-foreground-muted"
              className="min-h-80 rounded-2xl bg-grouped-card px-4 py-3 font-sans text-base text-foreground"
            />
            <View className="flex-row flex-wrap gap-2">
              <Button
                label="Save"
                tone="primary"
                loading={saving}
                disabled={!canEdit || !restored || uploading}
                onPress={() => void save(localBody.current)}
              />
              <Button
                label="Add image"
                icon="photo"
                tone="secondary"
                loading={uploading}
                disabled={!connected || !canAct}
                onPress={() => void addImages()}
              />
              {props.create && note === null && !row ? null : (
                <Button
                  label="Cancel"
                  tone="text"
                  disabled={saving || uploading}
                  onPress={() => {
                    const base = row?.body ?? note?.body ?? "";
                    setBody(base);
                    localBody.current = base;
                    setDirty(false);
                    setEditing(false);
                  }}
                />
              )}
            </View>
          </>
        ) : (
          <>
            {body.trim().length > 0 ? (
              <SelectableMarkdownText
                key={checkboxRender}
                markdown={body}
                preserveMarkdownSource
                textStyle={markdownStyles.nativeTextStyle}
                onLinkPress={(href) => void Linking.openURL(href)}
                renderImage={renderImage}
                onTaskListItemPress={
                  !canEdit || saving || conflicted
                    ? undefined
                    : (event) => {
                        const next = applyNoteCheckboxEvent(localBody.current, event);
                        if (next === null) {
                          setError("Edit the markdown to change this checkbox.");
                          // Native toggles before it reports, so redraw from the source.
                          setCheckboxRender((value) => value + 1);
                        } else if (next !== localBody.current) {
                          void save(next);
                        }
                      }
                }
              />
            ) : (
              <Text className="text-foreground-muted">Empty note</Text>
            )}
            {dirty ? (
              <Button
                label="Retry saving"
                tone="primary"
                disabled={saving || !canEdit}
                onPress={() => void save(localBody.current)}
              />
            ) : null}
            <Button
              label="Edit"
              icon="pencil"
              tone="secondary"
              disabled={!canEdit || saving || conflicted}
              onPress={() => {
                editBase.current = row?.baseRevision ?? note?.revision ?? null;
                const claimed = notesOutbox.claimImages(
                  environmentId,
                  props.path,
                  localBody.current,
                );
                setBody(claimed);
                localBody.current = claimed;
                setEditing(true);
              }}
            />
          </>
        )}

        {bodyAvailable && note !== null ? (
          <NoteProjectPicker
            environmentId={environmentId}
            value={project}
            missing={note.projectMissing === true}
            noneLabel="No project"
            accessibilityLabel="Note project"
            disabled={!canChangeHeader || busy}
            onChange={(next) => void runUpdate({ project: next })}
          />
        ) : null}
        {bodyAvailable && note !== null ? (
          card ? (
            <>
              <NoteCardSection
                environmentId={environmentId}
                link={card}
                {...(canChangeHeader && !busy
                  ? { onUnlink: () => void runUpdate({ card: null }) }
                  : {})}
              />
              <Button
                label="Start another card"
                icon="plus"
                tone="secondary"
                disabled={!canChangeHeader || busy}
                onPress={() =>
                  navigation.navigate("SettingsNoteStartWork", {
                    environmentId,
                    path: props.path,
                    another: true,
                  })
                }
              />
            </>
          ) : (
            <Button
              label="Start work"
              icon="sparkles"
              tone="secondary"
              disabled={!canChangeHeader || busy}
              onPress={() =>
                navigation.navigate("SettingsNoteStartWork", { environmentId, path: props.path })
              }
            />
          )
        ) : null}
        <FilePreviewModal source={expandedImage} onRequestClose={() => setExpandedImage(null)} />
      </ScrollView>
    </SettingsScreen>
  );
}

/** Uploads picked images as pending attachments; the server claims them for the note on save. */
async function uploadNoteImages(
  environmentId: EnvironmentId,
  images: Parameters<typeof prepareTurnAttachments>[0]["attachments"],
): Promise<ReadonlyArray<string>> {
  const prepared = await prepareTurnAttachments({
    environmentId,
    attachments: images,
    supportsImageUploads: true,
  });
  if (prepared.status !== "ready") return [];
  return prepared.attachments.flatMap((attachment) =>
    // An inline data URL was never stored on the server, so there is nothing to claim.
    "dataUrl" in attachment || attachment.id === undefined
      ? []
      : [attachmentImageMarkdown(attachment.name, attachment.id)],
  );
}
