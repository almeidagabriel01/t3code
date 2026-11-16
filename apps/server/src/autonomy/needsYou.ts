import {
  DECISION_CONTEXT_MAX_LENGTH,
  DECISION_MAX_OPTIONS,
  DECISION_OPTION_LABEL_MAX_LENGTH,
  DECISION_TITLE_MAX_LENGTH,
  type DecisionOption,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";

import { redactChannelText } from "../channels/channelRedaction.ts";
import {
  channelStrings,
  DECISION_PHRASES,
  type ResolvedChannelLanguage,
} from "../channels/channelStrings.ts";

const WANTS: Readonly<Record<string, string>> = {
  command: DECISION_PHRASES.wantsCommand,
  "file-change": DECISION_PHRASES.wantsFileChange,
  "file-read": DECISION_PHRASES.wantsFileRead,
};

/**
 * The message that tells `targetThreadId` (an assistant's conversation) about a wait. One id per
 * conversation and wait: a repeat replays its command receipt, so the owner's wake and the default
 * assistant's notice are one message when both go to the same conversation.
 */
export const WAIT_WAKE_PREFIX = "assistant-task-waits:";
export const waitWakeId = (targetThreadId: ThreadId, key: string) =>
  `${WAIT_WAKE_PREFIX}${targetThreadId}:${key}`;

export { MACHINE_REQUEST_KINDS } from "@t3tools/shared/needsUser";

/** A user-input option id points back at the option by position: `option:<index>`. */
const OPTION_PREFIX = "option:";
export const userInputOptionIndex = (optionId: string | undefined): number | undefined => {
  if (optionId?.startsWith(OPTION_PREFIX) !== true) return undefined;
  const index = Number(optionId.slice(OPTION_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
};

/** Redacts before it cuts, so a credential straddling the limit never leaves as a fragment. */
const clip = (text: string, max: number) => {
  const clean = redactChannelText(text);
  if (clean.length <= max) return clean;
  const cut = /[\uD800-\uDBFF]/.test(clean.charAt(max - 2)) ? max - 2 : max - 1;
  return `${clean.slice(0, cut)}…`;
};

/** How much of a decision's context a chat card shows. */
const CARD_CONTEXT_MAX_LENGTH = 1_200;

const tooLong = (text: string, max: number) => redactChannelText(text).length > max;

/**
 * A decision's context as a chat card shows it. Cut short, it says so: a card must never be
 * answered on the strength of a command or question the user could not read in full.
 */
export function cardContext(
  context: string,
  language: ResolvedChannelLanguage,
): { readonly text: string; readonly cut: boolean } {
  const trimmed = context.trim();
  if (!tooLong(trimmed, CARD_CONTEXT_MAX_LENGTH)) {
    return { text: redactChannelText(trimmed), cut: false };
  }
  return {
    text: `${clip(trimmed, CARD_CONTEXT_MAX_LENGTH)}\n${channelStrings(language).cutOpenInT3}`,
    cut: true,
  };
}

export interface RequestDecision {
  readonly title: string;
  readonly context: string;
  readonly options: ReadonlyArray<DecisionOption>;
  /** False when only the thread can answer it: the card then informs and links there. */
  readonly answerable: boolean;
}

type Request = Pick<OrchestrationV2RuntimeRequest, "kind" | "responseCapability">;

/**
 * The decision that stands in for a pending request. Approvals offer Approve and Deny; a single
 * single-choice question offers its options. The text keeps English T3 phrases so chats translate them.
 */
export function requestDecision(
  agent: string,
  request: Request,
  item: OrchestrationV2TurnItem | undefined,
): RequestDecision {
  const live = request.responseCapability.type === "live";
  if (request.kind === "user_input") {
    const questions = item?.type === "user_input_request" ? item.questions : [];
    const [only] = questions;
    const asked = questions
      .map((question) => question.question)
      .join("\n\n")
      .trim();
    const single =
      !tooLong(asked, DECISION_CONTEXT_MAX_LENGTH) &&
      questions.length === 1 &&
      only !== undefined &&
      only.multiSelect !== true &&
      only.options.length > 0 &&
      only.options.length <= DECISION_MAX_OPTIONS;
    return {
      title: clip(`${agent} ${DECISION_PHRASES.asksQuestion}`, DECISION_TITLE_MAX_LENGTH),
      context: clip(asked, DECISION_CONTEXT_MAX_LENGTH),
      options:
        single && live
          ? only.options.map((option, index) => ({
              id: `${OPTION_PREFIX}${index}`,
              label: clip(option.label, DECISION_OPTION_LABEL_MAX_LENGTH),
            }))
          : [{ id: "ok", label: DECISION_PHRASES.gotIt }],
      answerable: single && live,
    };
  }
  const detail = item?.type === "approval_request" ? item : undefined;
  const prompt = detail?.prompt?.trim();
  const context = [
    ...(prompt === undefined || prompt === ""
      ? []
      : [request.kind === "command" ? `\`\`\`sh\n${prompt}\n\`\`\`` : prompt]),
    ...(detail?.reason?.trim() ? [`${DECISION_PHRASES.reason} ${detail.reason.trim()}`] : []),
  ].join("\n\n");
  const approvable = live && !tooLong(context, DECISION_CONTEXT_MAX_LENGTH);
  return {
    title: clip(
      `${agent} ${WANTS[request.kind] ?? DECISION_PHRASES.needsApproval}`,
      DECISION_TITLE_MAX_LENGTH,
    ),
    context: clip(context, DECISION_CONTEXT_MAX_LENGTH),
    options: approvable
      ? [
          { id: "accept", label: DECISION_PHRASES.approve },
          { id: "decline", label: DECISION_PHRASES.deny },
        ]
      : [{ id: "ok", label: DECISION_PHRASES.gotIt }],
    answerable: approvable,
  };
}

export interface NeedsYouCard {
  readonly agent: string;
  /** The decision's title, already in the chat's language. */
  readonly title: string;
  readonly context: string;
  readonly threadTitle: string | null;
  readonly link: string | null;
  /** Answerable cards end with numbered choices; the rest point to T3. */
  readonly answerable: boolean;
}

/**
 * The chat text of a notice that something waits on the user, and whether the chat may answer it:
 * not when its context had to be cut. The outbox redacts all of it again.
 */
export function needsYouText(
  card: NeedsYouCard,
  language: ResolvedChannelLanguage,
): { readonly text: string; readonly answerable: boolean } {
  const t = channelStrings(language);
  const context = cardContext(card.context, language);
  const answerable = card.answerable && !context.cut;
  const where =
    card.threadTitle === null || card.threadTitle === card.agent
      ? ""
      : `${t.threadLabel} ${card.threadTitle}`;
  const lines = [
    t.waitingForYou(card.agent),
    card.title,
    where,
    context.text,
    answerable || context.cut ? "" : t.answerInT3,
    card.link === null ? "" : `${t.openInT3} ${card.link}`,
  ];
  return { text: lines.filter((line) => line !== "").join("\n\n"), answerable };
}

/**
 * The default assistant's short notice of a wait (title, origin and thread link), so it knows what
 * waits on the user. The card in Activity and the chat app asks it, so it only keeps it in mind.
 */
export function defaultNoticeText(input: {
  readonly title: string;
  readonly origin: string;
  /** The waiting thread as a chat link. */
  readonly link: string;
  readonly source: "request" | "decision";
}): string {
  const where = input.source === "decision" ? "in Activity" : "in that thread";
  return [
    `Waiting on the user: ${input.title}`,
    `From ${input.origin} in ${input.link}. They answer it ${where}.`,
    "It is also in Activity: keep it for when they ask what waits on them, never answer it for them, and reply in one line at most.",
  ].join("\n");
}
