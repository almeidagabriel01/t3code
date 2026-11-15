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
  assistantGroupHeldAttachments,
  assistantGroupSendRequestId,
  assistantGroupShownOutgoing,
  createAssistantGroupOutgoingStore,
  type AssistantGroupOutgoing,
  type AssistantGroupSendContext,
  type AssistantGroupTabKey,
  insertAssistantGroupMention,
  insertAssistantGroupProject,
  type AssistantGroupMentionOption,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  ASSISTANT_GROUP_MESSAGE_MAX_CHARS,
  type Assistant,
  type ChatAttachment,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { AtSignIcon, FolderIcon, ReplyIcon } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
} from "react";

import { collapseExpandedComposerCursor, composerSubmissionIntentForKey } from "~/composer-logic";
import {
  listContinuationForEnter,
  listIndentForTab,
  listOutdentForTab,
  type ComposerListEdit,
} from "~/composer-list-continuation";
import { useClientSettings } from "~/hooks/useSettings";
import { useSoftwareKeyboardOpen } from "~/hooks/useSoftwareKeyboardOpen";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { cn, randomUUID } from "~/lib/utils";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { useProject, useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { ComposerContextLabel } from "../ComposerContextLabel";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { ComposerAttachButton } from "../chat/ComposerAttachmentStrip";
import { ComposerBanner } from "../chat/ComposerBanner";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantAvatar } from "./assistantPresentation";
import { GroupAttachmentChips } from "./GroupAttachments";
import { GroupMentionChip } from "./GroupMentionChip";
import { type GroupMessageModel, GroupProjectModelPicker } from "./GroupProjectModel";
import { useGroupAttachments } from "./useGroupAttachments";

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

const LEAD_DECIDES = "lead";
const NO_CONTEXT_RECORDS = new Map();
const NO_SKILLS: never[] = [];

/** Unsent text per group, so leaving the chat and coming back keeps it. */
const drafts = new Map<string, string>();

/** For tests: each starts with empty drafts. */
export const clearGroupDrafts = () => {
  drafts.clear();
  outgoings.clear();
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
interface Outgoing extends AssistantGroupOutgoing {
  readonly prompt: PromptState;
  readonly projectLabel: string;
  readonly error: string | null;
  /** Its post's `clientRequestId`, so a resend of the same message never posts twice. */
  readonly requestId: string;
  readonly sendKey: string;
}

const outgoings = createAssistantGroupOutgoingStore<Outgoing>();

type RecipientsLineProps = Omit<
  Parameters<typeof assistantGroupRecipientsPreview>[0],
  "lead" | "leadCanRoute"
> & { readonly environmentId: EnvironmentId; readonly lead: Assistant | null };

/**
 * Who a draft reaches, under the composer. Only this line reads the lead's model and the
 * providers, so a provider update does not re-render the composer.
 */
function GroupRecipientsLine(props: RecipientsLineProps) {
  const { environmentId, lead } = props;
  const thread = useQuietThreadShell(
    lead?.threadId == null ? null : scopeThreadRef(environmentId, lead.threadId),
  );
  const project = useProject(lead === null ? null : scopeProjectRef(environmentId, lead.projectId));
  const settings = useServerConfigs().get(environmentId)?.settings;
  const providers = useEnvironmentProviders().get(environmentId);
  const leadCanRoute =
    lead === null || settings === undefined || providers === undefined
      ? undefined
      : assistantGroupLeadCanRoute({
          lead,
          threadModel: thread?.modelSelection,
          settings,
          providers,
          project,
        });
  return (
    <p
      data-testid="group-recipients"
      className="min-h-4 px-1 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {assistantGroupRecipientsPreview({ ...props, leadCanRoute })}
    </p>
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
  /** What the server reads besides the draft to route it, from the chat. */
  readonly sendContext: AssistantGroupSendContext;
  readonly onJumpToReply: () => void;
  readonly onClearReply: () => void;
  /** What the user sent before, oldest first, for ArrowUp recall. */
  readonly history: ReadonlyArray<{ readonly id: string; readonly text: string }>;
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
  const [draft, setDraftState] = useState<PromptState>(() => {
    const value = drafts.get(props.draftKey) ?? "";
    return {
      value,
      cursor: collapseExpandedComposerCursor(value, value.length),
      expanded: value.length,
    };
  });
  const setDraft = (value: string, cursor: number, expanded: number) => {
    if (value === "") drafts.delete(props.draftKey);
    else drafts.set(props.draftKey, value);
    setDraftState({ value, cursor, expanded });
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
  const items: ComposerCommandItem[] =
    memberAt !== null
      ? memberOptions.map((option) => memberItem(option, props.environmentId, props.leadId))
      : projectOptions.map((project) => ({
          id: `project:${project.id}`,
          type: "custom",
          icon: <FolderIcon aria-hidden className="size-4 shrink-0 text-secondary-label" />,
          label: project.name,
          description: `#${project.slug}`,
        }));
  const menuOpen = items.length > 0;
  const chosen = Math.min(highlight, Math.max(items.length - 1, 0));
  const attached = useGroupAttachments(
    props.environmentId,
    props.disabled,
    assistantGroupHeldAttachments(outgoing, shown),
  );

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
      ? "Waiting for files to upload"
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

  const send = async (value: string) => {
    if (!canSend || value.trim() === "") return;
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
      sendKey,
    };
    if (shown === null) setDraft("", 0, 0);
    setOutgoing(sent.tab, sent);
    setError(null);
    const result = await props.onSend(value.trim(), attached.ready, requestId);
    if (result.ok) {
      // Only the sent text goes: what the user wrote meanwhile in another tab stays.
      setOutgoing(sent.tab, null);
      recalled.current = null;
      attached.clear(sent.attachmentIds);
    } else setOutgoing(sent.tab, { ...sent, failed: true, error: result.message });
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

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    attached.add(files);
  };
  const onDrop = (event: DragEvent) => {
    setDragging(false);
    if (props.disabled || !hasFiles(event)) return;
    event.preventDefault();
    attached.add(Array.from(event.dataTransfer.files));
  };

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
    <div className="flex flex-col gap-1.5 px-3 pt-2 pb-3 @xl/group-chat:px-6">
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <div
            ref={shellRef}
            data-chat-composer-form="true"
            className="min-w-0"
            onDragOver={(event) => {
              if (props.disabled || !hasFiles(event)) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                setDragging(false);
              }
            }}
            onDrop={onDrop}
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
                          triggerKind={null}
                          listLabel={memberAt !== null ? "Mention" : "Projects"}
                          activeItemId={items[chosen]?.id ?? null}
                          onHighlightedItemChange={(id) => {
                            const index = items.findIndex((item) => item.id === id);
                            if (index >= 0) setHighlight(index);
                          }}
                          onSelect={(item) => pick(items.indexOf(item))}
                        />
                      </ComposerCommandMenuLayer>
                    ) : null}
                    <GroupAttachmentChips
                      items={attached.items}
                      onRemove={attached.remove}
                      onRetry={attached.retry}
                    />
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
                      skills={NO_SKILLS}
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
                          addComposerAttachments={async (files) => {
                            attached.add(files);
                            return false;
                          }}
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
          context={props.sendContext}
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
  );
}
