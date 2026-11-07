import {
  assistantGroupMentionOptions,
  assistantGroupMentionQuery,
  assistantGroupRecipientsPreview,
  insertAssistantGroupMention,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  ASSISTANT_GROUP_MESSAGE_MAX_CHARS,
  type Assistant,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AtSignIcon, SendIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { AssistantAvatar } from "./assistantPresentation";

export const MENTION_REQUIRED_COPY = "Mention a member with @, or set a lead in Edit group.";

export type GroupSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const OPTION_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Unsent text per group, so leaving the chat and coming back keeps it. */
const drafts = new Map<string, string>();

/** For tests: each starts with empty drafts. */
export const clearGroupDrafts = () => drafts.clear();

/** The group's message box: `@` picks members, Enter sends, and a line says who will get it. */
export function GroupComposer(props: {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<Assistant>;
  readonly leadId: Assistant["id"] | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly replyingTo: { readonly name: string } | null;
  readonly onClearReply: () => void;
  readonly onSend: (text: string) => Promise<GroupSendResult>;
}) {
  const [text, setDraft] = useState(() => drafts.get(props.draftKey) ?? "");
  const setText = (next: string) => {
    if (next === "") drafts.delete(props.draftKey);
    else drafts.set(props.draftKey, next);
    setDraft(next);
  };
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const lead = props.members.find((member) => member.id === props.leadId) ?? null;
  const mention = assistantGroupMentionQuery(text, caret);
  const options =
    mention === null ? [] : assistantGroupMentionOptions(mention.query, props.members);
  const pickerOpen = mention !== null && options.length > 0 && dismissedFor !== text;
  const chosen = Math.min(highlight, Math.max(options.length - 1, 0));
  const preview = assistantGroupRecipientsPreview(
    text,
    props.members,
    lead,
    props.replyingTo?.name ?? null,
  );
  const canSend = !props.disabled && !sending && text.trim() !== "";

  // The caret can only move once React has put the inserted text in the field.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places the DOM caret after an insert
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    field.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const pick = (index: number) => {
    const option = options[index];
    if (mention === null || option === undefined) return;
    const next = insertAssistantGroupMention(text, mention, option);
    setText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    setHighlight(0);
    field.current?.focus();
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const result = await props.onSend(text.trim());
    setSending(false);
    if (result.ok) {
      setText("");
      setCaret(0);
    } else setError(result.message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (pickerOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : options.length - 1;
        setHighlight((chosen + step) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(chosen);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedFor(text);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 pt-2 pb-3 @xl/group-chat:px-6">
      {props.replyingTo === null ? null : (
        <div className="flex items-center gap-1.5">
          <Badge variant="info" size="sm" data-testid="group-reply-chip">
            Replying to {props.replyingTo.name}
          </Badge>
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Cancel reply"
            onClick={props.onClearReply}
          >
            <XIcon />
          </Button>
        </div>
      )}
      <div className="relative">
        {pickerOpen ? (
          <ul
            role="listbox"
            aria-label="Mention"
            className="dropdown-glass absolute bottom-full left-0 z-10 mb-1 flex max-h-60 w-64 max-w-full flex-col overflow-y-auto rounded-lg p-1 shadow-lg"
          >
            {options.map((option, index) => (
              <li
                key={option.kind === "everyone" ? "everyone" : option.member.id}
                role="option"
                aria-selected={index === chosen}
                className="list-none"
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className={cn(OPTION_CLASS, index === chosen && "bg-foreground/8")}
                  // Keeps the focus in the field, so the caret stays where the mention is.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(index)}
                >
                  {option.kind === "everyone" ? (
                    <>
                      <AtSignIcon aria-hidden className="size-4.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate font-medium">@everyone</span>
                    </>
                  ) : (
                    <>
                      <AssistantAvatar
                        assistant={option.member}
                        environmentId={props.environmentId}
                        className="size-4.5"
                      />
                      <span className="min-w-0 truncate font-medium">{option.member.name}</span>
                      {option.member.role === "" ? null : (
                        <span className="min-w-0 truncate text-muted-foreground">
                          {option.member.role}
                        </span>
                      )}
                      {option.member.id === props.leadId ? (
                        <Badge variant="outline" size="sm" className="ms-auto">
                          lead
                        </Badge>
                      ) : null}
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={field}
            size="sm"
            aria-label="Message the group"
            placeholder={props.disabledReason ?? "Message the group. Type @ to pick who gets it."}
            disabled={props.disabled}
            maxLength={ASSISTANT_GROUP_MESSAGE_MAX_CHARS}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
              setHighlight(0);
              setError(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
          />
          <Button size="icon" aria-label="Send" disabled={!canSend} onClick={() => void send()}>
            <SendIcon />
          </Button>
        </div>
      </div>
      {error === null ? (
        <p
          data-testid="group-recipients"
          className="min-h-4 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {preview}
        </p>
      ) : (
        <p role="alert" className="min-h-4 text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
