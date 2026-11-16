import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_GROUP_LEAD_DECIDES_LABEL,
  assistantGroupLeadCanRoute,
  assistantGroupMentionOptions,
  assistantGroupMentionQuery,
  assistantGroupProjectOptions,
  assistantGroupProjectQuery,
  assistantGroupRecipientsPreview,
  assistantGroupHeldAttachments,
  assistantGroupSendRequestId,
  assistantGroupFailedSendRouting,
  assistantGroupShownOutgoing,
  createAssistantGroupOutgoingStore,
  insertAssistantGroupMention,
  type AssistantGroupOutgoing,
  type AssistantGroupSendRouting,
  type AssistantGroupTabPick,
  type AssistantGroupTabKey,
  insertAssistantGroupProject,
  type AssistantGroupMentionOption,
  type AssistantGroupMentionQuery,
} from "@t3tools/client-runtime/assistantGroupChat";
import { assistantGroupLandedSend } from "@t3tools/client-runtime/state/assistants";
import {
  ASSISTANT_GROUP_MESSAGE_MAX_CHARS,
  type Assistant,
  type AssistantGroupMessage,
  type AssistantGroupMessageId,
  type AssistantTeamId,
  type ChatAttachment,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import { FAILED_ATTACHMENT_BLOCK_REASON } from "../../lib/composerAttachmentUploadQueue";
import { isFileBackedComposerAttachment } from "../../lib/composerImages";
import { composerGroupMentions } from "../../lib/groupMentionChips";
import { uuidv4 } from "../../lib/uuid";
import { useAssistantFaceImages } from "../../native/ChipIconImages";
import { Menu } from "../../components/ui/Menu";
import { type AssistantGroupChatRef, useAssistantGroupSendContext } from "../../state/assistants";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig, useProject, useQuietThreadShell } from "../../state/entities";
import {
  clearComposerDraftContent,
  composerDraftsAtom,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";
import { ComposerPopoverSurface } from "../threads/ComposerCommandPopover";
import { ComposerSurface } from "../threads/ThreadComposer";
import {
  ComposerDictationCancelAction,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { clearGroupAttachments, useGroupAttachments } from "./GroupAttachments";
import { AssistantAvatar } from "./assistantPresentation";
import type { GroupProjectModel } from "./useGroupProjectModel";

const LEAD_DECIDES = "lead-decides";
/** Its text waits in the draft store under its tab's `:outgoing:` key. */
const outgoings = createAssistantGroupOutgoingStore<
  AssistantGroupOutgoing &
    GroupLandedSend & {
      readonly error: string | null;
      /** Its post's `clientRequestId`, so a resend of the same message never posts twice. */
      readonly requestId: string;
      readonly sendKey: string;
      /** The text it sent, trimmed; its draft key holds what the composer shows now. */
      readonly text: string;
    }
>();
/** For tests: each starts with no outgoing messages or files. */
export const clearGroupOutgoings = () => {
  outgoings.clear();
  clearGroupAttachments();
};
const EVERYONE = "everyone";
const EDITOR_INSET = 8;
const EDITOR_MAX_LINES = 6;

const QUOTE_ENTERING = FadeIn.duration(180)
  .easing(Easing.out(Easing.cubic))
  .reduceMotion(ReduceMotion.System);
const QUOTE_EXITING = FadeOut.duration(140)
  .easing(Easing.out(Easing.cubic))
  .reduceMotion(ReduceMotion.System);

export type GroupSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type GroupComposerProject = { readonly id: ProjectId; readonly name: string };
type GroupComposerProjectOption = GroupComposerProject & { readonly slug: string };

/** The message being answered, quoted on top of the composer. */
export type GroupReplyTarget = {
  readonly name: string;
  /** The member the reply goes to; null for a reply to the request itself. */
  readonly to: string | null;
  readonly projectId: ProjectId | null;
  readonly excerpt: string;
};

/** A reply being written, with the message it answers. */
export type GroupReply = GroupReplyTarget & { readonly id: AssistantGroupMessageId };

export type GroupSendRouting = AssistantGroupSendRouting<AssistantGroupTabPick<GroupReply>>;

/** A send the server took: from its reply, or from the chat showing a post whose reply was lost. */
export interface GroupLandedSend {
  readonly tab: AssistantGroupTabKey | null;
  /** The project it runs in; null lets the lead decide. */
  readonly projectId: ProjectId | null;
  /** What it went with; null once a landing let go of it. */
  readonly routing: GroupSendRouting | null;
}

/** A labelled menu trigger in the composer's toolbar row. */
function ToolbarChip(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly chevron?: boolean;
  /** Only the icon, when the row is too full for the label. */
  readonly iconOnly?: boolean;
  /** A dot after the label, always in view; the accessibility label says what it marks. */
  readonly marked?: boolean;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={props.onPress}
      // No cap of its own: a chip truncates only when the row runs out of room (`MenuSlot`).
      className="h-8 flex-row items-center gap-1.5 rounded-full bg-foreground/6 px-2.5 active:bg-foreground/12 disabled:opacity-50"
    >
      <SymbolView name={props.icon} size={13} tintColorClassName="accent-icon-subtle" />
      {props.iconOnly ? null : (
        <Text className="shrink text-xs font-t3-medium text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
      )}
      {props.marked && !props.iconOnly ? (
        <View testID="toolbar-chip-mark" className="size-1.5 shrink-0 rounded-full bg-primary" />
      ) : null}
      {props.chevron === false || props.iconOnly ? null : (
        <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon-subtle" />
      )}
    </Pressable>
  );
}

function MenuSlot(props: { readonly children: ReactNode; readonly keep?: boolean }) {
  // The Menu ignores layout classes on itself, so the wrapper carries them.
  return <View className={props.keep ? "shrink-0" : "shrink"}>{props.children}</View>;
}

function SuggestionRow(props: {
  readonly accessibilityLabel: string;
  readonly isLast: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className="flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:opacity-60"
      style={{ borderBottomWidth: props.isLast ? 0 : StyleSheet.hairlineWidth }}
    >
      {props.children}
    </Pressable>
  );
}

/** What `@` or `#` at the caret offers, in the thread composer's suggestion popover. */
function Suggestions(props: {
  readonly environmentId: EnvironmentId;
  readonly leadId: Assistant["id"] | null;
  readonly members: ReadonlyArray<AssistantGroupMentionOption<Assistant>>;
  readonly projects: ReadonlyArray<GroupComposerProjectOption>;
  readonly onPickMember: (option: AssistantGroupMentionOption<Assistant>) => void;
  readonly onPickProject: (project: GroupComposerProjectOption) => void;
}) {
  const showsMembers = props.members.length > 0;
  return (
    <ComposerPopoverSurface>
      <View className="px-3.5 pb-1 pt-2.5">
        <Text className="text-3xs font-t3-bold uppercase tracking-[0.8px] text-foreground-muted">
          {showsMembers ? "Members" : "Projects"}
        </Text>
      </View>
      <ScrollView
        className="max-h-[180px]"
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      >
        {showsMembers
          ? props.members.map((option, index) => (
              <SuggestionRow
                key={option.kind === "everyone" ? EVERYONE : option.member.id}
                accessibilityLabel={
                  option.kind === "everyone" ? "Mention everyone" : `Mention ${option.member.name}`
                }
                isLast={index === props.members.length - 1}
                onPress={() => props.onPickMember(option)}
              >
                {option.kind === "everyone" ? (
                  <>
                    <SymbolView name="person.2" size={16} tintColorClassName="accent-icon-subtle" />
                    <Text className="text-base font-t3-medium text-foreground">@everyone</Text>
                  </>
                ) : (
                  <>
                    <AssistantAvatar
                      assistant={option.member}
                      environmentId={props.environmentId}
                      size={20}
                    />
                    <Text
                      className="shrink-0 text-base font-t3-medium text-foreground"
                      numberOfLines={1}
                    >
                      {option.member.name}
                    </Text>
                    <Text
                      className="min-w-0 flex-1 text-xs text-foreground-muted"
                      numberOfLines={1}
                    >
                      {[
                        `@${option.member.handle}`,
                        option.member.role === "" ? null : option.member.role,
                        option.member.id === props.leadId ? "lead" : null,
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </Text>
                  </>
                )}
              </SuggestionRow>
            ))
          : props.projects.map((project, index) => (
              <SuggestionRow
                key={project.id}
                accessibilityLabel={`Mention project ${project.name}`}
                isLast={index === props.projects.length - 1}
                onPress={() => props.onPickProject(project)}
              >
                <SymbolView name="folder" size={14} tintColorClassName="accent-icon-subtle" />
                <Text
                  className="shrink-0 text-base font-t3-medium text-foreground"
                  numberOfLines={1}
                >
                  {project.name}
                </Text>
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                  #{project.slug}
                </Text>
              </SuggestionRow>
            ))}
      </ScrollView>
    </ComposerPopoverSurface>
  );
}

/** The quoted message on top of the composer: tap it to see the original, × to drop the reply. */
function ReplyQuote(props: {
  readonly target: GroupReplyTarget;
  readonly onJump: (() => void) | null;
  readonly onCancel: () => void;
}) {
  return (
    <Animated.View
      entering={QUOTE_ENTERING}
      exiting={QUOTE_EXITING}
      className="mx-2 mt-1 flex-row items-center gap-1 rounded-2xl bg-foreground/6 pl-3"
    >
      <SymbolView
        name="arrowshape.turn.up.left"
        size={13}
        tintColorClassName="accent-icon-subtle"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show the message from ${props.target.name}`}
        disabled={props.onJump === null}
        onPress={props.onJump ?? undefined}
        className="min-w-0 flex-1 gap-px py-1.5 pl-1.5 active:opacity-70"
      >
        <Text
          testID="group-reply-chip"
          className="text-xs font-t3-bold text-foreground"
          numberOfLines={1}
        >
          Replying to {props.target.name}
        </Text>
        {props.target.excerpt === "" ? null : (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.target.excerpt}
          </Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel reply"
        hitSlop={6}
        onPress={props.onCancel}
        className="size-9 items-center justify-center rounded-full active:bg-foreground/8"
      >
        <SymbolView name="xmark" size={12} tintColorClassName="accent-icon-subtle" />
      </Pressable>
    </Animated.View>
  );
}

/**
 * The group's message box, built on the thread composer's editor: `@` picks members, `#` names a
 * project, a line says who will get the message, and a new request can name its project.
 */
type RecipientsLineProps = Omit<
  Parameters<typeof assistantGroupRecipientsPreview>[0],
  "lead" | "leadCanRoute" | "context"
> & {
  readonly environmentId: EnvironmentId;
  readonly lead: Assistant | null;
  readonly chat: AssistantGroupChatRef;
};

/**
 * Who a draft reaches, under the composer. Only this line reads the lead's model and the
 * server config, so a provider update does not re-render the composer.
 */
function GroupRecipientsLine({ chat, ...props }: RecipientsLineProps) {
  const { environmentId, lead } = props;
  const context = useAssistantGroupSendContext(environmentId, chat);
  const thread = useQuietThreadShell(
    lead?.threadId == null ? null : scopeThreadRef(environmentId, lead.threadId),
  );
  const project = useProject(lead === null ? null : scopeProjectRef(environmentId, lead.projectId));
  const config = useEnvironmentServerConfig(environmentId);
  const leadCanRoute =
    lead === null || config === null
      ? undefined
      : assistantGroupLeadCanRoute({
          lead,
          threadModel: thread?.modelSelection,
          settings: config.settings,
          providers: config.providers,
          project,
        });
  return (
    <Text testID="group-recipients" className="min-h-4 px-3 text-xs text-foreground-muted">
      {assistantGroupRecipientsPreview({ ...props, context, leadCanRoute })}
    </Text>
  );
}

export function GroupComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly teamId: AssistantTeamId;
  /** The open tab: a message on its way shows only where `assistantGroupShowsOutgoing` says. */
  readonly tab: AssistantGroupTabKey | null;
  readonly members: ReadonlyArray<Assistant>;
  readonly leadId: Assistant["id"] | null;
  /** The group's projects, named. */
  readonly projects: ReadonlyArray<GroupComposerProject>;
  /** The project a new request gets; null lets the lead decide. A reply's project overrides it. */
  readonly projectId: ProjectId | null;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  /** Any project's name in this group, a reply's included. */
  readonly projectName: (projectId: ProjectId) => string;
  /** The model of the project the next message runs in; null hides its chip. */
  readonly projectModel: GroupProjectModel | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  /** The message being answered: with a project, the message stays in it. */
  readonly replyingTo: GroupReplyTarget | null;
  /** The reply and picks the next send goes with, so a failed one keeps them for its resend. */
  readonly routing: GroupSendRouting;
  readonly onLanded: (sent: GroupLandedSend) => void;
  /** A failed send came back into view: the chat takes back what it went with. */
  readonly onRestore: (routing: GroupSendRouting) => void;
  /** The chat the recipients line reads what routes the draft from. */
  readonly chat: AssistantGroupChatRef;
  /** Shows the quoted message in the list; null when it is not loaded. */
  readonly onJumpToReply: (() => void) | null;
  readonly onClearReply: () => void;
  /** The chat as loaded: a failed send whose post shows here landed. */
  readonly messages: ReadonlyMap<AssistantGroupMessageId, AssistantGroupMessage> | undefined;
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
    projectId: ProjectId | undefined,
    requestId: string,
  ) => Promise<GroupSendResult>;
}) {
  const groupKey = `assistant-group:${props.environmentId}:${props.teamId}`;
  // Sent text leaves the draft for its tab's key, so another tab never shows it beside its project.
  const outgoingKey = (tab: AssistantGroupTabKey | null) => `${groupKey}:outgoing:${tab ?? ""}`;
  const outgoing = useSyncExternalStore(outgoings.subscribe, () => outgoings.get(groupKey));
  const setOutgoing = (
    tab: AssistantGroupTabKey | null,
    next: Parameters<typeof outgoings.set>[2],
  ) => outgoings.set(groupKey, tab, next);
  const shown = assistantGroupShownOutgoing(outgoing, props.tab);
  const draftKey = shown === null ? groupKey : outgoingKey(shown.tab);
  const faces = useAssistantFaceImages(props.members);
  const { text } = useComposerDraft(draftKey);
  const [selection, setSelection] = useState(() => ({ start: text.length, end: text.length }));
  const [contentHeight, setContentHeight] = useState(0);
  // Only the open tab's own message on its way, or the one All shows, makes this composer wait.
  const sending = shown !== null && !shown.failed;
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const editor = useRef<ComposerEditorHandle>(null);
  // Set before the flush, so Return and a tap in the same moment post once from that tab.
  const inFlight = useRef(new Set<AssistantGroupTabKey | null>());
  const bodyText = useScaledTextRole("body");

  const write = (value: string, caret?: number) => {
    // A message on its way is not the user's to change.
    if (sending && shown !== null) return;
    setComposerDraftText(draftKey, value);
    if (caret !== undefined) setSelection({ start: caret, end: caret });
    setError(null);
    // A refused message is the user's to fix in its own tab; emptied, the tab takes the draft again.
    if (shown !== null) {
      setOutgoing(shown.tab, value === "" ? null : { ...shown, error: null });
    }
  };

  const voice = useVoiceInputController({
    ownerKey: draftKey,
    label: "Group message",
    readDraftMessage: () => getComposerDraftSnapshot(draftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection,
    disabled: props.disabled,
    onChangeDraftMessage: (value) => setComposerDraftText(draftKey, value),
    onChangeSelection: setSelection,
  });
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const showsDictation = presentation.statusKind === "active";

  const lead = props.members.find((member) => member.id === props.leadId) ?? null;
  const caret = Math.min(selection.end, text.length);
  const collapsed = selection.start === selection.end;
  const mention = collapsed ? assistantGroupMentionQuery(text, caret) : null;
  const projectMention =
    collapsed && mention === null && props.projects.length > 0
      ? assistantGroupProjectQuery(text, caret)
      : null;
  const memberOptions =
    mention === null ? [] : assistantGroupMentionOptions(mention.query, props.members);
  const projectOptions =
    projectMention === null
      ? []
      : assistantGroupProjectOptions(projectMention.query, props.projects);
  const attached = useGroupAttachments(
    groupKey,
    props.environmentId,
    assistantGroupHeldAttachments(outgoing, shown),
    new Set(outgoing.flatMap((entry) => entry.attachmentIds)),
  );
  // A file still uploading or failed holds the send, so it is never dropped without the user knowing.
  const canSend =
    !props.disabled &&
    !sending &&
    text.trim() !== "" &&
    !attached.unsettled &&
    !voice.blocksSubmission;

  const lockedProject = props.replyingTo?.projectId ?? null;
  const chosenProject = props.projectId;
  // All shows a message on its way from another tab with the project it goes to, and no model.
  const elsewhere = shown !== null && shown.tab !== props.tab;
  const pinned = elsewhere ? shown.projectId : lockedProject;
  const runProject = elsewhere ? null : (lockedProject ?? chosenProject);
  const { projectModel } = props;
  const projectName = (id: ProjectId | null) =>
    id === null ? ASSISTANT_GROUP_LEAD_DECIDES_LABEL : props.projectName(id);

  const attach = async (from: "files" | "media") => {
    const problem = await (from === "files" ? attached.pick() : attached.pickMedia()).catch(
      (cause: unknown) => (cause instanceof Error ? cause.message : "Could not attach the file."),
    );
    if (problem !== null) Dialog.alert("Could not attach", problem);
  };

  const insertMember = (
    at: AssistantGroupMentionQuery,
    option: AssistantGroupMentionOption<Assistant>,
    base = text,
  ) => {
    const next = insertAssistantGroupMention(base, at, option);
    write(next.text, next.caret);
  };

  const pickProject = (project: GroupComposerProjectOption) => {
    if (projectMention === null) return;
    const next = insertAssistantGroupProject(text, projectMention, project);
    write(next.text, next.caret);
  };

  const mentionAtCaret = (id: string) => {
    const option: AssistantGroupMentionOption<Assistant> | undefined =
      id === EVERYONE
        ? { kind: "everyone" }
        : (() => {
            const member = props.members.find((entry) => entry.id === id);
            return member === undefined ? undefined : { kind: "member", member };
          })();
    if (option === undefined) return;
    // A mention only counts after a space or the start of the text.
    const pad = caret > 0 && !/\s/.test(text[caret - 1]!) ? " " : "";
    const base = `${text.slice(0, caret)}${pad}${text.slice(caret)}`;
    const start = caret + pad.length;
    insertMember({ start, end: start, query: "" }, option, base);
  };

  /** A post the server took: only its text and files go, so what was written meanwhile stays. */
  const settle = (sent: (typeof outgoing)[number]) => {
    clearComposerDraftContent(outgoingKey(sent.tab));
    setOutgoing(sent.tab, null);
    attached.clear(sent.attachmentIds);
    props.onLanded(sent);
  };
  const seenSend = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the chat stream confirms a failed send whose reply was lost, and a failed send trades its routing with the chat's; the outgoing store is outside React
  useLayoutEffect(() => {
    const routing = assistantGroupFailedSendRouting(
      seenSend.current,
      shown,
      props.tab,
      props.routing,
    );
    seenSend.current = routing.seen;
    if (routing.restore !== null) props.onRestore(routing.restore);
    else if (shown !== null && routing.keep !== null) {
      setOutgoing(shown.tab, { ...shown, routing: routing.keep });
    }
    if (props.messages === undefined) return;
    for (const entry of outgoing) {
      const live = getComposerDraftSnapshot(outgoingKey(entry.tab)).text;
      const landed = assistantGroupLandedSend(entry, live, props.messages.values());
      if (landed === "settle") settle(entry);
      else if (landed === "clear-warning") {
        // The post landed: what it went with goes, and the user's edit is a new message.
        setOutgoing(entry.tab, { ...entry, error: null, routing: null });
        props.onLanded(entry);
      }
    }
  });

  const post = async () => {
    // An edit iOS has not delivered yet (an accepted autocorrection) belongs to this message.
    await editor.current?.flushPendingInput();
    const message = getComposerDraftSnapshot(draftKey).text.trim();
    if (message === "") return;
    if (message.length > ASSISTANT_GROUP_MESSAGE_MAX_CHARS) {
      setError(
        `Messages can be up to ${ASSISTANT_GROUP_MESSAGE_MAX_CHARS.toLocaleString()} characters.`,
      );
      return;
    }
    setError(null);
    const projectId = lockedProject === null ? (chosenProject ?? undefined) : undefined;
    const attachmentIds = attached.items.map((item) => item.id);
    // A refused or unconfirmed message goes again under its first id, unless anything changed.
    const { requestId, sendKey } = assistantGroupSendRequestId(
      shown?.failed === true ? shown : null,
      [message, attachmentIds, projectId, props.projectModel?.messageModel, props.replyingTo],
      uuidv4,
    );
    const sent = {
      tab: props.tab,
      failed: false,
      requestId,
      text: message,
      sendKey,
      attachmentIds,
      projectId: runProject,
      routing: props.routing,
      error: null,
    };
    const sentKey = outgoingKey(sent.tab);
    setComposerDraftText(sentKey, message);
    if (draftKey === groupKey) clearComposerDraftContent(groupKey);
    setOutgoing(sent.tab, sent);
    setSelection({ start: 0, end: 0 });
    const result = await props.onSend(message, attached.ready, projectId, requestId);
    if (result.ok) settle(sent);
    else {
      // What the user changed while it was on its way is what its resend goes with.
      const latest = outgoings.get(groupKey).find((entry) => entry.requestId === sent.requestId);
      setOutgoing(sent.tab, { ...(latest ?? sent), failed: true, error: result.message });
    }
  };

  const send = async () => {
    const tab = props.tab;
    if (!canSend || inFlight.current.has(tab)) return;
    inFlight.current.add(tab);
    await post().finally(() => {
      inFlight.current.delete(tab);
    });
  };

  const showsProject = elsewhere || lockedProject !== null || props.projects.length > 1;
  const shownError =
    shown?.error ?? error ?? (attached.failed ? FAILED_ATTACHMENT_BLOCK_REASON : null);
  const lineHeight = bodyText.lineHeight;
  const editorHeight =
    Math.min(Math.max(contentHeight, lineHeight), lineHeight * EDITOR_MAX_LINES) + 2 * EDITOR_INSET;

  return (
    <View className="gap-1.5 px-3 pb-2 pt-1.5">
      {memberOptions.length === 0 && projectOptions.length === 0 ? null : (
        <Suggestions
          environmentId={props.environmentId}
          leadId={props.leadId}
          members={memberOptions}
          projects={projectOptions}
          onPickMember={(option) => {
            if (mention !== null) insertMember(mention, option);
          }}
          onPickProject={pickProject}
        />
      )}
      <ComposerSurface style={{ borderRadius: 24, borderCurve: "continuous", paddingVertical: 4 }}>
        <ComposerDictationError
          error={voice.state.phase === "error" ? voice.state.error : null}
          onDismiss={voice.cancel}
        />
        {props.replyingTo === null ? null : (
          <ReplyQuote
            target={props.replyingTo}
            onJump={props.onJumpToReply}
            onCancel={props.onClearReply}
          />
        )}
        {attached.items.length === 0 ? null : (
          <View className="px-3 pt-2">
            <ComposerAttachmentStrip
              attachments={attached.items.map((item) => item.source)}
              ownUploads={attached.uploads}
              onRemove={attached.remove}
              onPressPreview={(source) => {
                setPreviewVideo(null);
                setPreviewFile(source);
              }}
              onPressVideo={(attachment, sourceIdentifier) => {
                setPreviewFile(null);
                setPreviewVideo({ type: "local", attachment, sourceIdentifier });
              }}
              // No thread to open it in: the system viewer shows the local file.
              onPressDocument={(attachment) => {
                if (!isFileBackedComposerAttachment(attachment)) return;
                setPreviewVideo(null);
                setPreviewFile({
                  kind: "document",
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  attachment,
                  sourceIdentifier: `draft-file:${attachment.id}`,
                });
              }}
            />
          </View>
        )}
        <View className="px-3.5" style={{ height: editorHeight }}>
          <ComposerEditor
            ref={editor}
            draftKey={draftKey}
            environmentId={props.environmentId}
            groupMentions={composerGroupMentions(props.members, props.projects, faces)}
            multiline
            value={text}
            selection={selection}
            editable={!props.disabled}
            readOnly={(sending && shown !== null) || voice.freezesEditor}
            placeholder={
              props.disabledReason ??
              (props.projects.length > 0
                ? "Message the group. @ picks who gets it, # picks a project."
                : "Message the group. Type @ to pick who gets it.")
            }
            scrollEnabled={contentHeight > lineHeight * EDITOR_MAX_LINES}
            contentInsetVertical={EDITOR_INSET}
            onContentSizeChange={(size) => setContentHeight(size.height)}
            onChangeText={(value) => write(value)}
            onSelectionChange={setSelection}
            onPasteImages={(uris) => {
              if (props.disabled || attached.full || sending) return;
              void attached.paste(uris).catch(() => {
                Dialog.alert("Could not attach", "The pasted image could not be attached.");
              });
            }}
            onSubmit={() => void send()}
            submitTitle="Send"
            alternateSubmitTitle="Send"
            style={{ flex: 1 }}
            textStyle={bodyText}
          />
        </View>
        {showsDictation ? (
          <ComposerDictationToolbar showsDictation>
            <View className="h-11 flex-row items-center px-1">
              <ComposerDictationCancelAction presentation={presentation} onCancel={voice.cancel} />
              <ComposerDictationStatus
                audioLevels={voice.audioLevels}
                elapsedSeconds={voice.elapsedSeconds}
                phase={voice.state.phase}
                presentation={presentation}
              />
              <ComposerDictationPrimaryAction
                state={voice.state}
                presentation={presentation}
                isAvailable={voice.isAvailable}
                disabled={props.disabled}
                onStart={voice.start}
                onConfirm={voice.stop}
                onCancel={voice.cancel}
              />
            </View>
          </ComposerDictationToolbar>
        ) : (
          <View className="flex-row items-center gap-1 pl-0.5 pr-1">
            <ComposerAttachmentButton
              disabled={props.disabled || attached.full || sending}
              supportsFiles
              onPickMedia={() => attach("media")}
              onPickFiles={() => attach("files")}
            />
            {!showsProject ? null : elsewhere || pinned !== null ? (
              <MenuSlot>
                <ToolbarChip
                  icon="folder"
                  label={projectName(pinned)}
                  accessibilityLabel={`Project: ${projectName(pinned)}`}
                  chevron={false}
                  disabled
                />
              </MenuSlot>
            ) : (
              // A long project name gives way first, so the model's name stays whole.
              <MenuSlot>
                <Menu
                  accessibilityLabel="Project"
                  actions={[
                    {
                      id: LEAD_DECIDES,
                      title: ASSISTANT_GROUP_LEAD_DECIDES_LABEL,
                      state: chosenProject === null ? "on" : "off",
                    },
                    ...props.projects.map((project) => ({
                      id: project.id,
                      title: project.name,
                      state: project.id === chosenProject ? ("on" as const) : ("off" as const),
                    })),
                  ]}
                  onPressAction={({ nativeEvent }) =>
                    props.onProjectChange(
                      nativeEvent.event === LEAD_DECIDES ? null : (nativeEvent.event as ProjectId),
                    )
                  }
                >
                  <ToolbarChip
                    icon="folder"
                    label={projectName(chosenProject)}
                    accessibilityLabel={`Project: ${projectName(chosenProject)}`}
                    disabled={props.disabled}
                  />
                </Menu>
              </MenuSlot>
            )}
            {projectModel === null || runProject === null ? null : projectModel.forMessage ? (
              <MenuSlot keep>
                <Menu
                  accessibilityLabel="Model for this message"
                  title="This message only"
                  actions={[
                    { id: "change", title: "Change model" },
                    { id: "default", title: `Back to ${projectModel.defaultLabel}` },
                  ]}
                  onPressAction={({ nativeEvent }) =>
                    nativeEvent.event === "change"
                      ? projectModel.openMessagePicker()
                      : projectModel.clearMessageModel()
                  }
                >
                  <ToolbarChip
                    icon="cube"
                    label={projectModel.shortLabel}
                    marked
                    accessibilityLabel={`Model for this message: ${projectModel.label}`}
                    disabled={props.disabled}
                  />
                </Menu>
              </MenuSlot>
            ) : (
              <MenuSlot keep>
                <ToolbarChip
                  icon="cube"
                  label={projectModel.shortLabel}
                  accessibilityLabel={`Model for ${projectName(runProject)}: ${projectModel.label}`}
                  chevron={false}
                  disabled={props.disabled}
                  onPress={projectModel.openMessagePicker}
                />
              </MenuSlot>
            )}
            {props.members.length === 0 ? null : (
              <MenuSlot keep={projectModel !== null && runProject !== null}>
                <Menu
                  accessibilityLabel="Mention"
                  actions={[
                    ...props.members.map((member) => ({
                      id: member.id,
                      title: member.name,
                      ...(member.role === "" ? {} : { subtitle: member.role }),
                    })),
                    { id: EVERYONE, title: "Everyone" },
                  ]}
                  onPressAction={({ nativeEvent }) => mentionAtCaret(nativeEvent.event)}
                >
                  <ToolbarChip
                    icon="at"
                    label="Mention"
                    accessibilityLabel="Mention a member"
                    chevron={false}
                    iconOnly={projectModel !== null && runProject !== null}
                    disabled={props.disabled}
                  />
                </Menu>
              </MenuSlot>
            )}
            <View className="flex-1" />
            <ComposerDictationStartAction
              state={voice.state}
              isAvailable={voice.isAvailable}
              disabled={props.disabled}
              onStart={voice.start}
              onCancel={voice.cancel}
            />
            <ComposerActionButton
              accessibilityLabel={sending ? "Sending" : "Send"}
              icon="arrow.up"
              variant="primary"
              busy={sending}
              disabled={!canSend}
              onPress={() => void send()}
            />
          </View>
        )}
      </ComposerSurface>
      {shownError === null ? (
        <GroupRecipientsLine
          environmentId={props.environmentId}
          text={text}
          members={props.members}
          lead={lead}
          projects={props.projects}
          projectId={props.projectId}
          chat={props.chat}
        />
      ) : (
        <Text accessibilityRole="alert" className="min-h-4 px-3 text-xs text-danger-foreground">
          {shownError}
        </Text>
      )}
      <VideoPreviewModal source={previewVideo} onRequestClose={() => setPreviewVideo(null)} />
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </View>
  );
}
