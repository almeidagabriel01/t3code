import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_GROUP_LEAD_DECIDES_LABEL,
  assistantGroupLeadCanRoute,
  assistantGroupMentionOptions,
  assistantGroupMentionQuery,
  assistantGroupMentionTargets,
  assistantGroupProjectOptions,
  assistantGroupProjectQuery,
  assistantGroupRecipientsPreview,
  assistantGroupComposerSession,
  type AssistantGroupChatState,
  assistantGroupHeldAttachments,
  assistantGroupSendRequestId,
  assistantGroupFailedSendRouting,
  assistantGroupShownOutgoing,
  createAssistantGroupOutgoingStore,
  type AssistantGroupOutgoing,
  type AssistantGroupSendRouting,
  type AssistantGroupTabPick,
  type AssistantGroupTabKey,
  insertAssistantGroupMention,
  insertAssistantGroupProject,
  type AssistantGroupMentionOption,
  assistantGroupDraftThreadId,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  describeCatalogEntry,
  getProviderSkillsForSlashMenu,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { assistantGroupLandedSend } from "@t3tools/client-runtime/state/assistants";
import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  ASSISTANT_GROUP_MESSAGE_MAX_CHARS,
  assistantGroupAddress,
  type Assistant,
  type AssistantGroupMessage,
  type AssistantGroupMessageId,
  type ChatAttachment,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { AtSignIcon, FolderIcon, ReplyIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
} from "react";

import {
  collapseExpandedComposerCursor,
  composerSubmissionIntentForKey,
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  type ComposerTrigger,
} from "~/composer-logic";
import {
  listContinuationForEnter,
  listIndentForTab,
  listOutdentForTab,
  type ComposerListEdit,
} from "~/composer-list-continuation";
import { useClientSettings, useEnvironmentSettings } from "~/hooks/useSettings";
import { useSoftwareKeyboardOpen } from "~/hooks/useSoftwareKeyboardOpen";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { cn, randomUUID } from "~/lib/utils";
import { searchProviderSkills } from "~/providerSkillSearch";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { type AssistantGroupChatRef, useAssistantGroupSendContext } from "~/state/assistants";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { useComposerDraftStore, useComposerThreadDraft } from "~/composerDraftStore";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { usePrimaryEnvironmentId } from "~/state/environments";
import {
  primaryServerKeybindingsAtom,
  providersIgnoringCheckedAtAtom,
  serverEnvironment,
} from "~/state/server";
import { readPreparedConnection } from "~/state/session";
import { ComposerContextLabel } from "../ComposerContextLabel";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import {
  ComposerAttachButton,
  ComposerAttachmentFileList,
  ComposerAttachmentMediaRow,
  ComposerFilePreviewDialog,
} from "../chat/ComposerAttachmentStrip";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ComposerContextMeter } from "../chat/ComposerContextMeter";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "../chat/ComposerCommandMenu";
import { ComposerCommandMenuLayer } from "../chat/ComposerCommandMenuLayer";
import { ComposerControl, ComposerSelectControl } from "../chat/ComposerControl";
import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { ComposerSurface } from "../chat/ComposerSurface";
import {
  composerOtherFilesForPresentation,
  isPreviewableComposerVideo,
  shouldHandleComposerAttachmentPaste,
} from "../chat/composerAttachmentFiles";
import { searchSlashCommandItems } from "../chat/composerSlashCommandSearch";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { folderDropTarget, resolveDroppedFolderPath } from "../chat/folderDrop";
import { useComposerAttachmentIntake } from "../chat/useComposerAttachmentIntake";
import { useFileAttachmentCapabilities } from "../chat/useFileAttachmentCapabilities";
import { makeWorkspaceFileDropHandlers, splitTransferredFiles } from "../chat/workspaceFileDrop";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
  type ComposerPromptHistoryPosition,
} from "../chat/composerPromptHistory";
import { Badge } from "../ui/badge";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantAvatar } from "./assistantPresentation";
import { GroupMentionChip } from "./GroupMentionChip";
import { type GroupMessageModel, GroupProjectModelPicker } from "./GroupProjectModel";
import { clearGroupAttachments, useGroupAttachments } from "./useGroupAttachments";

export type GroupSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface GroupProjectOption {
  readonly id: ProjectId;
  readonly label: string;
}

/** What the composer quotes while the user writes a reply. */
export interface GroupReplyQuote {
  /** "Replying to Ada", or "Replying to request: <title>". */
  readonly label: string;
  /** One line of the original, or empty. */
  readonly excerpt: string;
  /** The member the reply goes to, for the recipients line; null for a whole request. */
  readonly to: string | null;
  /** A reply's request runs in this project when it has one, so the picker is locked to it. */
  readonly projectId: ProjectId | null;
  readonly projectLabel: string | null;
}

/** A reply being written: the message it answers, quoted on top of the composer. */
export interface GroupReplyTarget {
  readonly id: AssistantGroupMessageId;
  readonly projectId: ProjectId | null;
  readonly quote: GroupReplyQuote;
}

export type GroupSendRouting = AssistantGroupSendRouting<AssistantGroupTabPick<GroupReplyTarget>>;

/** A send the server took: from its reply, or from the chat showing a post whose reply was lost. */
export interface GroupLandedSend {
  readonly tab: AssistantGroupTabKey | null;
  /** The project it runs in; null lets the lead decide. */
  readonly projectId: ProjectId | null;
  /** What it went with; null once a landing let go of it. */
  readonly routing: GroupSendRouting | null;
}

const LEAD_DECIDES = "lead";
// Context chips need records sent beside the text, and a group post carries only text and files.
const NO_CONTEXT_RECORDS = new Map();
const NO_SKILLS: ServerProvider["skills"] = [];
const NOT_REVERTING = { current: false };
const GROUP_INTAKE_THREAD_ID = ThreadId.make("group-composer");
const NO_INLINE_FILES: ReadonlySet<string> = new Set();
const NO_IDS: ReadonlyArray<never> = [];

/** For tests: each starts with empty drafts. */
export const clearGroupDrafts = () => {
  useComposerDraftStore.setState((state) => ({
    draftsByThreadKey: Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([key]) => !key.includes(":assistant-group:")),
    ),
  }));
  outgoings.clear();
  clearGroupAttachments();
};

function MentionOptionLabel(props: {
  readonly option: AssistantGroupMentionOption<Assistant>;
  readonly environmentId: EnvironmentId;
  readonly leadId: Assistant["id"] | null;
}) {
  const { option } = props;
  if (option.kind === "everyone") {
    return (
      <>
        <AtSignIcon aria-hidden className="size-4.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">@everyone</span>
      </>
    );
  }
  return (
    <>
      <AssistantAvatar
        assistant={option.member}
        environmentId={props.environmentId}
        className="size-4.5"
      />
      <span className="min-w-0 truncate font-medium">{option.member.name}</span>
      {option.member.role === "" ? null : (
        <span className="min-w-0 truncate text-muted-foreground">{option.member.role}</span>
      )}
      {option.member.id === props.leadId ? (
        <Badge variant="outline" size="sm" className="ms-auto">
          lead
        </Badge>
      ) : null}
    </>
  );
}

function memberItem(
  option: AssistantGroupMentionOption<Assistant>,
  environmentId: EnvironmentId,
  leadId: Assistant["id"] | null,
): ComposerCommandItem {
  if (option.kind === "everyone") {
    return {
      id: "everyone",
      type: "custom",
      icon: <AtSignIcon aria-hidden className="size-4 shrink-0 text-secondary-label" />,
      label: "@everyone",
      description: "Everyone in the group",
    };
  }
  const { member } = option;
  return {
    id: `member:${member.id}`,
    type: "custom",
    icon: <AssistantAvatar assistant={member} environmentId={environmentId} className="size-4" />,
    trailing:
      member.id === leadId ? (
        <Badge variant="outline" size="sm" className="ms-auto">
          lead
        </Badge>
      ) : null,
    label: member.name,
    description: member.role === "" ? `@${member.handle}` : member.role,
  };
}

/** The reply being written, quoted on top of the composer; leaving it fades it out first. */
function ReplyQuote(props: {
  readonly quote: GroupReplyQuote | null;
  readonly onJump: () => void;
  readonly onCancel: () => void;
}) {
  const [shown, setShown] = useState(props.quote);
  const leaving = props.quote === null && shown !== null;
  if (props.quote !== null && props.quote !== shown) setShown(props.quote);
  if (
    leaving &&
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    setShown(null);
  }
  if (shown === null) return null;
  return (
    <ComposerBanner.Dock>
      <ComposerBanner.Column>
        <ComposerBanner.Attachment
          data-testid="group-reply-chip"
          data-leaving={leaving || undefined}
          inert={leaving}
          className="transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0 data-leaving:translate-y-1 data-leaving:opacity-0 motion-reduce:transition-none"
          onTransitionEnd={(event) => {
            if (leaving && event.target === event.currentTarget) setShown(null);
          }}
        >
          <ComposerBanner.Root density="comfortable">
            <ComposerBanner.Row>
              <ComposerBanner.Icon>
                <ReplyIcon />
              </ComposerBanner.Icon>
              <ComposerBanner.Content>
                <button
                  type="button"
                  data-testid="group-reply-jump"
                  className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 rounded-md px-1 py-1 text-start outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={props.onJump}
                >
                  <span className="max-w-[70%] shrink-0 truncate font-medium text-foreground">
                    {shown.label}
                  </span>{" "}
                  {shown.excerpt === "" ? null : (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {shown.excerpt}
                    </span>
                  )}
                </button>
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <Tooltip>
                  <TooltipTrigger
                    render={<ComposerBanner.Dismiss aria-label="Cancel reply" />}
                    onClick={props.onCancel}
                  />
                  <TooltipPopup>Cancel reply · Esc</TooltipPopup>
                </Tooltip>
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
          </ComposerBanner.Root>
        </ComposerBanner.Attachment>
      </ComposerBanner.Column>
    </ComposerBanner.Dock>
  );
}

/**
 * The group's message box: the thread composer's editor, where `@` picks members and `#` picks a
 * project as chips, Enter sends, and a line says who will get it.
 */
type PromptState = { readonly value: string; readonly cursor: number; readonly expanded: number };

/** A sent message the composer holds apart from the draft, with what its tab showed. */
interface Outgoing extends AssistantGroupOutgoing, GroupLandedSend {
  readonly prompt: PromptState;
  readonly projectLabel: string;
  readonly error: string | null;
  /** Its post's `clientRequestId`, so a resend of the same message never posts twice. */
  readonly requestId: string;
  readonly sendKey: string;
  /** The text it sent, trimmed; `prompt` is what the composer shows now. */
  readonly text: string;
}

const outgoings = createAssistantGroupOutgoingStore<Outgoing>();

type RecipientsLineProps = Omit<
  Parameters<typeof assistantGroupRecipientsPreview>[0],
  "lead" | "leadCanRoute" | "context"
> & {
  readonly environmentId: EnvironmentId;
  readonly lead: Assistant | null;
  readonly chat: AssistantGroupChatRef;
};

/**
 * How full the context is of the session a reply lands in, read from the server once per thread
 * and again whenever that member's task moves. Hidden for a new request, which opens fresh threads.
 */
function GroupContextMeter(props: {
  readonly environmentId: EnvironmentId;
  readonly state: AssistantGroupChatState | null;
  readonly chat: AssistantGroupChatRef;
  readonly text: string;
  readonly members: ReadonlyArray<Assistant>;
  readonly leadId: Assistant["id"] | null;
}) {
  const { environmentId, state, chat } = props;
  const context = useAssistantGroupSendContext(environmentId, chat);
  const replyId = chat.reply?.id ?? null;
  const session = assistantGroupComposerSession({
    state,
    requestId: replyId === null ? null : (state?.messages.get(replyId)?.requestId ?? replyId),
    text: props.text,
    members: props.members,
    leadId: props.leadId,
    context,
  });
  const query = useEnvironmentQuery(
    session === null
      ? null
      : orchestrationEnvironment.threadContextUsage({
          environmentId,
          input: { threadId: session.threadId },
        }),
  );
  const { refresh } = query;
  const moved = session?.updatedAt ?? null;
  const readAt = useRef(moved);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server's usage moves with the task
  useEffect(() => {
    if (moved === null || readAt.current === moved) return;
    readAt.current = moved;
    refresh();
  }, [moved, refresh]);
  const usage = query.data;
  const snapshot =
    session === null || usage == null
      ? null
      : deriveLatestContextWindowSnapshot([], usage.latestTurnUsage, usage.providerThread);
  if (snapshot === null) return null;
  const owner = props.members.find((member) => member.id === session!.ownerId)?.name ?? "member";
  return <ComposerContextMeter usage={snapshot} owner={`Context of ${owner} in this request`} />;
}

/**
 * Who a draft reaches, under the composer. Only this line reads the lead's model and the
 * providers, so a provider update does not re-render the composer.
 */
function GroupRecipientsLine({ chat, ...props }: RecipientsLineProps) {
  const { environmentId, lead } = props;
  const context = useAssistantGroupSendContext(environmentId, chat);
  const thread = useQuietThreadShell(
    lead?.threadId == null ? null : scopeThreadRef(environmentId, lead.threadId),
  );
  const project = useProject(lead === null ? null : scopeProjectRef(environmentId, lead.projectId));
  // This environment's config only: the all-environment maps change with every other one.
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const leadCanRoute =
    lead === null || config == null
      ? undefined
      : assistantGroupLeadCanRoute({
          lead,
          threadModel: thread?.modelSelection,
          settings: config.settings,
          providers: config.providers,
          project,
        });
  return (
    <p
      data-testid="group-recipients"
      className="min-h-4 px-1 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {assistantGroupRecipientsPreview({ ...props, context, leadCanRoute })}
    </p>
  );
}

/**
 * The skills of the provider a draft runs on: the message's own model, else the model of the member
 * it names first or replies to, else the lead's, read in that member's checkout.
 */
function useGroupDraftSkills(input: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly members: ReadonlyArray<Assistant>;
  readonly lead: Assistant | null;
  readonly replyTo: string | null;
  readonly model: ModelSelection | null;
}) {
  const recipient =
    assistantGroupAddress(input.text, input.members)?.[0] ??
    input.members.find((member) => member.name === input.replyTo) ??
    input.lead;
  const thread = useQuietThreadShell(
    recipient?.threadId == null ? null : scopeThreadRef(input.environmentId, recipient.threadId),
  );
  const project = useProject(
    recipient === null ? null : scopeProjectRef(input.environmentId, recipient.projectId),
  );
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(input.environmentId));
  const instanceId = input.model?.instanceId ?? thread?.modelSelection.instanceId;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return {
    driver: provider?.driver ?? null,
    skills:
      provider === undefined
        ? NO_SKILLS
        : resolveProviderSkillsForCwd(provider, thread?.worktreePath ?? project?.workspaceRoot),
  };
}

/** The skill menu for a `$` or `/` trigger, as the thread composer lists it. */
function skillItems(
  trigger: ComposerTrigger,
  skills: ServerProvider["skills"],
  driver: ServerProvider["driver"],
  showInSlashMenu: boolean,
): ComposerCommandItem[] {
  const item = (skill: ServerProvider["skills"][number], label: string) => ({
    id: `skill:${driver}:${skill.name}`,
    type: "skill" as const,
    provider: driver,
    skill,
    label,
    description: describeCatalogEntry(
      skill.shortDescription ?? skill.description,
      false,
      skill.scope ? `${skill.scope} skill` : "Run provider skill",
    ),
  });
  if (trigger.kind === "skill") {
    return searchProviderSkills(skills, trigger.query).map((skill) =>
      item(skill, formatProviderSkillDisplayName(skill)),
    );
  }
  return searchSlashCommandItems(
    getProviderSkillsForSlashMenu(skills, showInSlashMenu).map((skill) =>
      item(skill, `/skill:${skill.name}`),
    ),
    trigger.query.trim().toLowerCase(),
  );
}

export function GroupComposer(props: {
  readonly draftKey: string;
  /** The open tab: a message on its way shows only where `assistantGroupShowsOutgoing` says. */
  readonly tab: AssistantGroupTabKey | null;
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<Assistant>;
  readonly leadId: Assistant["id"] | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  /** The group's projects, for the project picker and `#` mentions. */
  readonly projects: ReadonlyArray<GroupProjectOption>;
  /** Null lets the lead decide. */
  readonly projectId: ProjectId | null;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  readonly teamDefault: ModelSelection | null;
  /** The model the next message runs on, picked here only for it. */
  readonly messageModel: GroupMessageModel;
  readonly replyingTo: GroupReplyQuote | null;
  /** The reply and picks the next send goes with, so a failed one keeps them for its resend. */
  readonly routing: GroupSendRouting;
  readonly onLanded: (sent: GroupLandedSend) => void;
  /** A failed send came back into view: the chat takes back what it went with. */
  readonly onRestore: (routing: GroupSendRouting) => void;
  /** The chat the recipients line reads what routes the draft from. */
  readonly chat: AssistantGroupChatRef;
  readonly onJumpToReply: () => void;
  readonly onClearReply: () => void;
  /** What the user sent before, oldest first, for ArrowUp recall. */
  readonly history: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  /** The chat as loaded: a failed send whose post shows here landed. */
  readonly messages: ReadonlyMap<AssistantGroupMessageId, AssistantGroupMessage> | undefined;
  /** The loaded chat, for the session whose context the meter shows. */
  readonly state: AssistantGroupChatState | null;
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
    requestId: string,
  ) => Promise<GroupSendResult>;
}) {
  const richText = useClientSettings((settings) => settings.composerRichTextEnabled);
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const softwareKeyboardOpen = useSoftwareKeyboardOpen();
  const resolvedTheme = useRenderedAppearance();
  const listId = useId();
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  // Unsent text lives in the thread draft store, so it survives a reload and lights the sidebar row.
  const draftRef = scopeThreadRef(
    props.environmentId,
    assistantGroupDraftThreadId(props.chat.teamId),
  );
  const storedDraft = useComposerThreadDraft(draftRef).prompt;
  const [caret, setCaret] = useState<PromptState | null>(null);
  // The caret holds only while it matches the stored text; a discard elsewhere moves it to the end.
  const draft: PromptState =
    caret !== null && caret.value === storedDraft
      ? caret
      : {
          value: storedDraft,
          cursor: collapseExpandedComposerCursor(storedDraft, storedDraft.length),
          expanded: storedDraft.length,
        };
  const setDraft = (value: string, cursor: number, expanded: number) => {
    useComposerDraftStore.getState().setPrompt(draftRef, value);
    setCaret({ value, cursor, expanded });
  };
  // Sent text leaves the draft, so another tab's composer never shows it beside its own project.
  const outgoing = useSyncExternalStore(outgoings.subscribe, () => outgoings.get(props.draftKey));
  const setOutgoing = (tab: AssistantGroupTabKey | null, next: Outgoing | null) =>
    outgoings.set(props.draftKey, tab, next);
  const shown = assistantGroupShownOutgoing(outgoing, props.tab);
  // Only the open tab's own message on its way, or the one All shows, makes this composer wait.
  const sending = shown !== null && !shown.failed;
  const prompt = shown?.prompt ?? draft;
  const setPrompt = (value: string, cursor: number, expanded: number) => {
    if (shown === null) return setDraft(value, cursor, expanded);
    // A refused message is the user's to fix in its own tab; emptied, the tab takes the draft again.
    setOutgoing(
      shown.tab,
      value === ""
        ? null
        : {
            ...shown,
            prompt: { value, cursor, expanded },
            error: null,
          },
    );
  };
  // The caret sits beside a chip, where `@` and `#` start nothing.
  const [besideChip, setBesideChip] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const recalled = useRef<ComposerPromptHistoryPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const projectRefs = props.projects.map((project) => ({ id: project.id, name: project.label }));
  const lead = props.members.find((member) => member.id === props.leadId) ?? null;
  const triggers = !besideChip && dismissedFor !== prompt.value;
  const memberAt = triggers ? assistantGroupMentionQuery(prompt.value, prompt.expanded) : null;
  const projectAt =
    triggers && memberAt === null && projectRefs.length > 0
      ? assistantGroupProjectQuery(prompt.value, prompt.expanded)
      : null;
  const memberOptions =
    memberAt === null ? [] : assistantGroupMentionOptions(memberAt.query, props.members);
  const projectOptions =
    projectAt === null ? [] : assistantGroupProjectOptions(projectAt.query, projectRefs);
  const { skills, driver } = useGroupDraftSkills({
    environmentId: props.environmentId,
    text: prompt.value,
    members: props.members,
    lead,
    replyTo: props.replyingTo?.to ?? null,
    model: props.messageModel.pick?.value ?? null,
  });
  const showSkillsInSlashMenu = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.showSkillsInSlashMenu,
  );
  // `@` and `#` stay the group's; only the thread's skill triggers carry over.
  // No context chips (file, thread, card): the group post has no `context` field yet (spec D3).
  const detected =
    triggers && memberAt === null && projectAt === null && driver !== null
      ? detectComposerTrigger(prompt.value, prompt.expanded)
      : null;
  const skillAt =
    detected?.kind === "skill" || detected?.kind === "slash-command" ? detected : null;
  const items: ComposerCommandItem[] =
    memberAt !== null
      ? memberOptions.map((option) => memberItem(option, props.environmentId, props.leadId))
      : projectAt !== null
        ? projectOptions.map((project) => ({
            id: `project:${project.id}`,
            type: "custom",
            icon: <FolderIcon aria-hidden className="size-4 shrink-0 text-secondary-label" />,
            label: project.name,
            description: `#${project.slug}`,
          }))
        : skillAt !== null && driver !== null
          ? skillItems(skillAt, skills, driver, showSkillsInSlashMenu)
          : [];
  const menuOpen = items.length > 0;
  const chosen = Math.min(highlight, Math.max(items.length - 1, 0));
  const attached = useGroupAttachments(
    props.draftKey,
    props.environmentId,
    assistantGroupHeldAttachments(outgoing, shown),
    new Set(outgoing.flatMap((entry) => entry.attachmentIds)),
  );
  const capabilities = useFileAttachmentCapabilities(props.environmentId);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const replace = (value: string, caret: number) => {
    const cursor = collapseExpandedComposerCursor(value, caret);
    setPrompt(value, cursor, caret);
    setHighlight(0);
    setError(null);
    // Typing may land before the frame; then the editor already holds the caret.
    window.requestAnimationFrame(() => {
      if (editorRef.current?.readSnapshot().value === value) editorRef.current.focusAt(cursor);
    });
  };

  const speech = useTextFieldSpeech({
    environmentId: props.environmentId,
    projectId: props.projectId,
    ownerKey: JSON.stringify(["group-chat", props.draftKey]),
    text: prompt.value,
    textareaRef: shellRef,
    selection: {
      read: () =>
        editorRef.current?.readSelectionRange() ?? { start: prompt.expanded, end: prompt.expanded },
      place: (selection) =>
        editorRef.current?.focusAt(
          collapseExpandedComposerCursor(editorRef.current.readSnapshot().value, selection.start),
        ),
    },
    onTextChange: (text) => replace(text, text.length),
    disabled: props.disabled || sending,
    offerSetup: true,
  });
  const tooLong = prompt.value.length > ASSISTANT_GROUP_MESSAGE_MAX_CHARS;
  // A file still uploading or failed holds the send, so it is never dropped without the user knowing.
  const sendDisabledReason =
    props.disabledReason ??
    (attached.unsettled
      ? attached.failed
        ? "Retry or remove the file that failed to upload"
        : "Waiting for files to upload"
      : tooLong
        ? `Messages are limited to ${ASSISTANT_GROUP_MESSAGE_MAX_CHARS} characters`
        : speech.preparing
          ? "Preparing voice input"
          : null);
  const hasContent = prompt.value.trim() !== "" || speech.blocksSubmission;
  const canSend = !props.disabled && !sending && sendDisabledReason === null && hasContent;
  // All shows a message on its way from another tab with the project it goes to.
  const elsewhere = shown !== null && shown.tab !== props.tab;
  const shownError = shown?.error ?? error;
  const lockedProject = elsewhere ? shown.projectLabel : (props.replyingTo?.projectLabel ?? null);

  const pick = (index: number) => {
    if (memberAt !== null) {
      const option = memberOptions[index];
      if (option === undefined) return;
      const next = insertAssistantGroupMention(prompt.value, memberAt, option);
      replace(next.text, next.caret);
    } else if (projectAt !== null) {
      const project = projectOptions[index];
      if (project === undefined) return;
      const next = insertAssistantGroupProject(prompt.value, projectAt, project);
      replace(next.text, next.caret);
    } else if (skillAt !== null) {
      const item = items[index];
      if (item?.type !== "skill") return;
      const replacement = `$${item.skill.name} `;
      const end = extendReplacementRangeForTrailingSpace(
        prompt.value,
        skillAt.rangeEnd,
        replacement,
      );
      replace(
        `${prompt.value.slice(0, skillAt.rangeStart)}${replacement}${prompt.value.slice(end)}`,
        skillAt.rangeStart + replacement.length,
      );
    }
  };

  const insertFromMenu = (option: AssistantGroupMentionOption<Assistant>) => {
    const { value } = prompt;
    const at = Math.min(
      editorRef.current?.readSnapshot().expandedCursor ?? value.length,
      value.length,
    );
    const gap = at > 0 && !/\s/.test(value[at - 1]!) ? " " : "";
    const spaced = `${value.slice(0, at)}${gap}${value.slice(at)}`;
    const start = at + gap.length;
    const next = insertAssistantGroupMention(spaced, { start, end: start, query: "" }, option);
    replace(next.text, next.caret);
  };

  /** A post the server took: only its text and files go, so what was written meanwhile stays. */
  const settle = (sent: Outgoing) => {
    setOutgoing(sent.tab, null);
    recalled.current = null;
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
      const landed = assistantGroupLandedSend(entry, entry.prompt.value, props.messages.values());
      if (landed === "settle") settle(entry);
      else if (landed === "clear-warning") {
        // The post landed: what it went with goes, and the user's edit is a new message.
        setOutgoing(entry.tab, { ...entry, error: null, routing: null });
        props.onLanded(entry);
      }
    }
  });

  const send = async (value: string) => {
    if (!canSend || value.trim() === "") return;
    const ready = attached.ready();
    if (ready === null) return;
    const attachmentIds = attached.items.map((item) => item.id);
    // A refused or unconfirmed message goes again under its first id, unless anything changed.
    const { requestId, sendKey } = assistantGroupSendRequestId(
      shown?.failed === true ? shown : null,
      [value.trim(), attachmentIds, props.projectId, props.messageModel.pick, props.replyingTo],
      randomUUID,
    );
    const sent: Outgoing = {
      tab: props.tab,
      failed: false,
      prompt: {
        value,
        cursor: collapseExpandedComposerCursor(value, value.length),
        expanded: value.length,
      },
      attachmentIds,
      projectLabel:
        lockedProject ??
        projectItems.find((item) => item.value === (props.projectId ?? LEAD_DECIDES))?.label ??
        ASSISTANT_GROUP_LEAD_DECIDES_LABEL,
      error: null,
      requestId,
      text: value.trim(),
      sendKey,
      projectId: props.replyingTo?.projectId ?? props.projectId,
      routing: props.routing,
    };
    if (shown === null) setDraft("", 0, 0);
    setOutgoing(sent.tab, sent);
    setError(null);
    const result = await props.onSend(value.trim(), ready, requestId);
    if (result.ok) settle(sent);
    else {
      // What the user changed while it was on its way is what its resend goes with.
      const latest = outgoings
        .get(props.draftKey)
        .find((entry) => entry.requestId === sent.requestId);
      setOutgoing(sent.tab, { ...(latest ?? sent), failed: true, error: result.message });
    }
    // The editor is read-only while its text is on its way; the user types on once it settles.
    window.requestAnimationFrame(() => {
      if (document.activeElement === document.body) editorRef.current?.focusAtEnd();
    });
  };
  const submit = () => speech.submitAfterDictation((value) => void send(value));

  const applyListEdit = (
    listEdit: (value: string, start: number, end: number) => ComposerListEdit | null,
  ) => {
    const selection = editorRef.current?.readSelectionRange();
    if (!selection || selection.start !== selection.end) return false;
    const edit = listEdit(prompt.value, selection.start, selection.end);
    if (edit === null) return false;
    replace(
      `${prompt.value.slice(0, edit.start)}${edit.replacement}${prompt.value.slice(edit.end)}`,
      edit.cursorAfter,
    );
    return true;
  };

  const recall = (direction: "backward" | "forward", event: KeyboardEvent) => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
    if (attached.items.length > 0) return false;
    const position = recalled.current?.recalled === prompt.value ? recalled.current : null;
    if (position === null && prompt.value.length > 0) return false;
    if (!editorRef.current?.isCaretOnVisualEdge(direction === "backward" ? "start" : "end")) {
      return false;
    }
    const step = stepComposerPromptHistory({
      direction,
      entries: buildComposerPromptHistoryEntries(
        props.history.map((message) => ({ id: message.id, role: "user", text: message.text })),
      ),
      position,
      currentPrompt: prompt.value,
    });
    if (step === null) return false;
    recalled.current = step.position;
    replace(step.prompt, step.prompt.length);
    return true;
  };

  const onCommandKey = (key: string, event: KeyboardEvent, inList = false) => {
    if (event.isComposing || event.keyCode === 229) return false;
    if (menuOpen) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        setHighlight((chosen + (key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
        return true;
      }
      if ((key === "Enter" || key === "Tab") && !event.shiftKey) {
        pick(chosen);
        return true;
      }
      if (key === "Escape") {
        setDismissedFor(prompt.value);
        return true;
      }
    }
    if (key === "Escape" && props.replyingTo !== null) {
      props.onClearReply();
      return true;
    }
    const intent = composerSubmissionIntentForKey({
      event,
      keybindings,
      isSoftwareKeyboardOpen: softwareKeyboardOpen,
      isDraftThread: false,
      sendShortcut,
      prompt: prompt.value,
    });
    if (intent !== null) {
      submit();
      return true;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      return recall(key === "ArrowUp" ? "backward" : "forward", event);
    }
    if (key === "Tab" && event.shiftKey) return applyListEdit(listOutdentForTab);
    if (key === "Enter" && inList) return false;
    if (key === "Enter") return applyListEdit(listContinuationForEnter);
    if (key === "Tab") return applyListEdit(listIndentForTab);
    return false;
  };

  const intake = useComposerAttachmentIntake({
    // The intake takes files only for a thread; this id stands for the group and names no thread.
    activeThreadId: GROUP_INTAKE_THREAD_ID,
    activePendingProgress: null,
    activePendingIsResponding: false,
    pendingUserInputs: [],
    supportsQuestionAttachments: false,
    isLiteralPendingAnswer: false,
    projectSelectionRequired: false,
    questionAttachmentTarget: null,
    attachmentTargetKey: attached.targetKey,
    fileStagingLimit: capabilities.fileStagingLimit,
    promptRef: { current: prompt.value },
    composerImagesRef: { current: attached.images },
    composerFilesRef: { current: attached.files },
    composerEditorRef: editorRef,
    isRevertingCheckpointRef: NOT_REVERTING,
    setThreadError: (_thread, message) => setError(message),
    countReservedAttachments: attached.reserved,
    addComposerImage: (image) => attached.add([image]),
    addComposerImagesToDraft: attached.add,
    addComposerFilesToDraft: attached.add,
    removeComposerImageFromDraft: attached.remove,
    // Attachment chips need context records, which a group post cannot carry.
    insertAttachmentReferences: () => false,
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const addFolders = (folders: ReadonlyArray<File>) => {
    const target = folderDropTarget({
      localEnvironmentDisabled: isLocalEnvironmentDisabled(),
      environmentId: props.environmentId,
      primaryEnvironmentId,
      connection: readPreparedConnection(props.environmentId),
      isDesktopRenderer: window.desktopBridge !== undefined,
    });
    if (target === "remote") {
      toastManager.add({
        type: "error",
        title: "Folders can only be referenced on a server running on this computer",
      });
      return;
    }
    const links = folders.flatMap((folder) => {
      const path = resolveDroppedFolderPath(folder, window.desktopBridge?.getPathForFile);
      if (path !== null) return [serializeComposerFileLink(path)];
      toastManager.add({
        type: "error",
        title: `Couldn't get the path of "${folder.name}"`,
        description: "Type the folder path instead.",
      });
      return [];
    });
    if (links.length === 0) return;
    const gap = prompt.value === "" || /\s$/.test(prompt.value) ? "" : " ";
    const next = `${prompt.value}${gap}${links.join(" ")} `;
    replace(next, next.length);
  };
  const addFiles = (files: File[]) => {
    void intake.addComposerAttachments(files).then((inserted) => {
      if (!inserted) editorRef.current?.focus();
    });
  };
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    if (props.disabled || sending) return;
    const { files, folders } = splitTransferredFiles(event.clipboardData);
    const plainText = event.clipboardData.getData("text/plain");
    if (
      folders.length > 0 ||
      (files.length > 0 && shouldHandleComposerAttachmentPaste({ files, plainText }))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (folders.length > 0) addFolders(folders);
      if (files.length > 0) void intake.addComposerAttachments(files);
      return;
    }
    if (intake.foldPastedText(plainText, false)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const fileDrop = makeWorkspaceFileDropHandlers({
    setDragActive: (active) => setDragging(active && !props.disabled && !sending),
    addFiles: useStableCallback((files: File[]) => {
      if (!props.disabled && !sending) addFiles(files);
    }),
    addFolders: useStableCallback((folders: File[]) => {
      if (!props.disabled && !sending) addFolders(folders);
    }),
  });
  const videos = attached.files.filter((file) =>
    isPreviewableComposerVideo(file, props.environmentId),
  );
  const otherFiles = composerOtherFilesForPresentation(
    attached.files,
    props.environmentId,
    NO_INLINE_FILES,
  );
  const previewFile = attached.files.find((file) => file.id === previewFileId);

  const projectItems = [
    { value: LEAD_DECIDES, label: ASSISTANT_GROUP_LEAD_DECIDES_LABEL },
    ...props.projects.map((project) => ({ value: project.id as string, label: project.label })),
  ];
  const projectPicker =
    lockedProject !== null ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-testid="group-project-locked"
              className="inline-flex h-7 min-w-0 items-center gap-1.5 px-1.75 text-sm text-muted-foreground sm:h-6 sm:text-xs"
            />
          }
        >
          <FolderIcon aria-hidden className="size-3 shrink-0" />
          <ComposerContextLabel>{lockedProject}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>The reply stays in its request's project</TooltipPopup>
      </Tooltip>
    ) : props.projects.length === 0 ? null : (
      <Select
        modal={false}
        value={props.projectId ?? LEAD_DECIDES}
        items={projectItems}
        disabled={props.disabled}
        onValueChange={(value: string | null) =>
          props.onProjectChange(
            value === null || value === LEAD_DECIDES ? null : (value as ProjectId),
          )
        }
      >
        <ComposerSelectControl size="xs" className="min-w-0 shrink" aria-label="Project">
          <FolderIcon className="size-3" />
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </ComposerSelectControl>
        <SelectPopup alignItemWithTrigger={false} side="top">
          <SelectGroup>
            <SelectGroupLabel>Project</SelectGroupLabel>
            {projectItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
    );

  // The project the message runs in: a reply's request project, else the picker's.
  const modelProjectId = elsewhere ? null : (props.replyingTo?.projectId ?? props.projectId);
  const modelProjectLabel =
    props.replyingTo?.projectLabel ??
    props.projects.find((project) => project.id === modelProjectId)?.label ??
    "this project";

  return (
    <div className="chat-composer-lane pt-2 pb-3">
      <div className="chat-content-lane flex flex-col gap-1.5">
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <div
              ref={shellRef}
              data-chat-composer-form="true"
              className="min-w-0"
              onDragEnter={fileDrop.onDragEnter}
              onDragOver={fileDrop.onDragOver}
              onDragLeave={fileDrop.onDragLeave}
              onDrop={fileDrop.onDrop}
            >
              <ReplyQuote
                quote={props.replyingTo}
                onJump={props.onJumpToReply}
                onCancel={() => {
                  props.onClearReply();
                  editorRef.current?.focus();
                }}
              />
              <div className="relative">
                <ComposerSurface.Main>
                  <div
                    data-testid="group-composer-surface"
                    className={cn(
                      "rounded-2xl transition-[background-color] duration-200",
                      dragging && "bg-accent/45 ring-1 ring-inset ring-primary/70",
                    )}
                  >
                    <div ref={setMenuAnchor} className="relative px-4 pt-3.5 pb-2 sm:pt-4">
                      {menuOpen ? (
                        <ComposerCommandMenuLayer anchor={menuAnchor}>
                          <ComposerCommandMenu
                            listId={listId}
                            items={items}
                            resolvedTheme={resolvedTheme}
                            isLoading={false}
                            triggerKind={skillAt?.kind ?? null}
                            listLabel={
                              memberAt !== null
                                ? "Mention"
                                : projectAt !== null
                                  ? "Projects"
                                  : "Skills"
                            }
                            activeItemId={items[chosen]?.id ?? null}
                            onHighlightedItemChange={(id) => {
                              const index = items.findIndex((item) => item.id === id);
                              if (index >= 0) setHighlight(index);
                            }}
                            onSelect={(item) => pick(items.indexOf(item))}
                          />
                        </ComposerCommandMenuLayer>
                      ) : null}
                      {attached.images.length + videos.length + attached.preparing.length > 0 ? (
                        <ComposerAttachmentMediaRow
                          images={attached.images}
                          expandedImages={attached.images}
                          preparingImages={attached.preparing}
                          videos={videos}
                          pendingSnapShotAnimations={NO_IDS}
                          pendingSnapShotIds={NO_IDS}
                          uncommittedSnapShotIds={NO_IDS}
                          nonPersistedImageIds={NO_IDS}
                          snapShotAnimations={false}
                          supportsAttachmentUploads={capabilities.supportsAttachmentUploads}
                          maxFileAttachmentBytes={capabilities.maxFileAttachmentBytes}
                          environmentId={props.environmentId}
                          canOperateThread={!props.disabled && !sending}
                          onExpandImage={setExpandedImage}
                          // A group file keeps its local copy until sent, so a video always plays it.
                          onFileOpen={() => {}}
                          onRemoveImage={intake.removeComposerImage}
                          onRemoveFile={attached.remove}
                        />
                      ) : null}
                      {otherFiles.length > 0 ? (
                        <ComposerAttachmentFileList
                          files={otherFiles}
                          resolvedTheme={resolvedTheme}
                          supportsAttachmentUploads={capabilities.supportsAttachmentUploads}
                          maxFileAttachmentBytes={capabilities.maxFileAttachmentBytes}
                          fileStagingLimit={capabilities.fileStagingLimit}
                          environmentId={props.environmentId}
                          canOperateThread={!props.disabled && !sending}
                          onPreviewFile={setPreviewFileId}
                          onRemoveFile={attached.remove}
                        />
                      ) : null}
                      {previewFile ? (
                        <ComposerFilePreviewDialog
                          file={previewFile}
                          onRemove={attached.remove}
                          onPreviewFileIdChange={setPreviewFileId}
                        />
                      ) : null}
                      {expandedImage ? (
                        <ExpandedImageDialog
                          preview={expandedImage}
                          onClose={() => setExpandedImage(null)}
                        />
                      ) : null}
                      <ComposerPromptEditorTiptap
                        draftKey={props.draftKey}
                        editorRef={editorRef}
                        ariaLabel="Message the group"
                        suggestionListId={listId}
                        activeSuggestionId={
                          menuOpen && items[chosen]
                            ? composerSuggestionOptionId(listId, items[chosen].id)
                            : undefined
                        }
                        richTextEnabled={richText}
                        value={prompt.value}
                        cursor={prompt.cursor}
                        contextRecords={NO_CONTEXT_RECORDS}
                        skills={skills}
                        disabled={
                          props.disabled || speech.freezesEditor || (sending && shown !== null)
                        }
                        placeholder={
                          props.disabledReason ??
                          "Message the group. @ picks who gets it, # picks a project."
                        }
                        groupMentions={{
                          ...assistantGroupMentionTargets(props.members, projectRefs),
                          render: (kind, value) => (
                            <GroupMentionChip
                              kind={kind}
                              value={value}
                              members={props.members}
                              projects={projectRefs}
                              environmentId={props.environmentId}
                            />
                          ),
                        }}
                        onChange={(value, cursor, expanded, adjacent) => {
                          setPrompt(value, cursor, expanded);
                          setBesideChip(adjacent);
                          setHighlight(0);
                          setError(null);
                        }}
                        onCommandKeyDown={onCommandKey}
                        onPaste={onPaste}
                      />
                    </div>
                    <div
                      data-testid="group-composer-controls"
                      // A narrow composer keeps its labels as icons, and voice and send hold the right
                      // edge outside the wrap, so the controls never take a third line.
                      className="flex min-w-0 items-end gap-1 px-2 pb-2 @max-md/composer-surface:[&_[data-composer-control-label]]:hidden @max-md/composer-surface:[&_[data-composer-control-mark]]:block"
                    >
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                        {/* A long project name shrinks beside attach instead of taking a line alone. */}
                        <div className="flex min-w-0 items-center gap-1">
                          <ComposerAttachButton
                            addComposerAttachments={intake.addComposerAttachments}
                            focusComposer={() => editorRef.current?.focus()}
                            disabled={props.disabled || attached.full || sending}
                          />
                          {projectPicker}
                        </div>
                        <div className="flex min-w-0 items-center gap-1">
                          {modelProjectId === null ? null : (
                            <GroupProjectModelPicker
                              environmentId={props.environmentId}
                              projectId={modelProjectId}
                              projectLabel={modelProjectLabel}
                              teamDefault={props.teamDefault}
                              disabled={props.disabled}
                              onError={setError}
                              message={props.messageModel}
                            />
                          )}
                          <Menu>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <MenuTrigger
                                    disabled={props.disabled || props.members.length === 0}
                                    render={<ComposerControl size="xs" aria-label="Mention" />}
                                  />
                                }
                              >
                                <AtSignIcon className="size-3" />
                                <span data-composer-control-label>Mention</span>
                              </TooltipTrigger>
                              <TooltipPopup side="top">Mention a member</TooltipPopup>
                            </Tooltip>
                            <MenuPopup align="start" side="top">
                              <MenuGroup>
                                <MenuGroupLabel>Mention</MenuGroupLabel>
                                {assistantGroupMentionOptions("", props.members).map((option) => (
                                  <MenuItem
                                    key={option.kind === "everyone" ? "everyone" : option.member.id}
                                    onClick={() => insertFromMenu(option)}
                                  >
                                    <MentionOptionLabel
                                      option={option}
                                      environmentId={props.environmentId}
                                      leadId={props.leadId}
                                    />
                                  </MenuItem>
                                ))}
                              </MenuGroup>
                            </MenuPopup>
                          </Menu>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <GroupContextMeter
                          environmentId={props.environmentId}
                          state={props.state}
                          chat={props.chat}
                          text={prompt.value}
                          members={props.members}
                          leadId={props.leadId}
                        />
                        <ComposerPrimaryActions
                          compact={false}
                          canOperateThread={!props.disabled}
                          pendingAction={null}
                          isRunning={false}
                          canInterrupt={false}
                          voiceInputActive={speech.blocksSubmission}
                          isSendBusy={sending}
                          sendDisabledReason={canSend || !hasContent ? null : sendDisabledReason}
                          isEnvironmentUnavailable={false}
                          isPreparingWorktree={false}
                          hasSendableContent={hasContent && canSend}
                          onSubmitMessage={submit}
                          onPreviousPendingQuestion={() => {}}
                          onInterrupt={() => {}}
                        >
                          <TextFieldSpeechControls
                            speech={speech}
                            disabled={props.disabled || sending}
                          />
                        </ComposerPrimaryActions>
                      </div>
                    </div>
                  </div>
                </ComposerSurface.Main>
              </div>
            </div>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
        {shownError === null ? (
          <GroupRecipientsLine
            environmentId={props.environmentId}
            text={prompt.value}
            members={props.members}
            lead={lead}
            projects={projectRefs}
            projectId={props.projectId}
            chat={props.chat}
          />
        ) : (
          <p
            role="alert"
            data-testid="group-composer-alert"
            className="min-h-4 px-1 text-xs text-destructive-foreground"
          >
            {shownError}
          </p>
        )}
      </div>
    </div>
  );
}
