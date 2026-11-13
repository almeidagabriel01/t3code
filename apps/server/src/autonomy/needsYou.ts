import {
  DECISION_CONTEXT_MAX_LENGTH,
  DECISION_MAX_OPTIONS,
  DECISION_OPTION_LABEL_MAX_LENGTH,
  DECISION_TITLE_MAX_LENGTH,
  type DecisionOption,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
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

/** Kinds T3 answers itself; every other pending request waits on the user. */
export const MACHINE_REQUEST_KINDS = ["dynamic_tool_call", "auth_refresh"] as const;

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
    const single =
      questions.length === 1 &&
      only !== undefined &&
      only.multiSelect !== true &&
      only.options.length > 0 &&
      only.options.length <= DECISION_MAX_OPTIONS;
    return {
      title: clip(`${agent} ${DECISION_PHRASES.asksQuestion}`, DECISION_TITLE_MAX_LENGTH),
      context: clip(
        questions
          .map((question) => question.question)
          .join("\n\n")
          .trim(),
        DECISION_CONTEXT_MAX_LENGTH,
      ),
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
  return {
    title: clip(
      `${agent} ${WANTS[request.kind] ?? DECISION_PHRASES.needsApproval}`,
      DECISION_TITLE_MAX_LENGTH,
    ),
    context: clip(context, DECISION_CONTEXT_MAX_LENGTH),
    options: live
      ? [
          { id: "accept", label: DECISION_PHRASES.approve },
          { id: "decline", label: DECISION_PHRASES.deny },
        ]
      : [{ id: "ok", label: DECISION_PHRASES.gotIt }],
    answerable: live,
  };
}

export interface NeedsYouCard {
  readonly agent: string;
  /** The decision's title, already in the chat's language. */
  readonly title: string;
  readonly context: string;
  readonly projectName: string | null;
  readonly threadTitle: string | null;
  readonly link: string | null;
  /** Answerable cards end with numbered choices; the rest point to T3. */
  readonly answerable: boolean;
}

/** The chat text of a notice that something waits on the user; the outbox redacts all of it again. */
export function needsYouText(card: NeedsYouCard, language: ResolvedChannelLanguage): string {
  const t = channelStrings(language);
  const where = [
    ...(card.projectName === null ? [] : [`${t.projectLabel} ${card.projectName}`]),
    ...(card.threadTitle === null || card.threadTitle === card.agent
      ? []
      : [`${t.threadLabel} ${card.threadTitle}`]),
  ].join(" · ");
  const lines = [
    t.waitingForYou(card.agent),
    card.title,
    where,
    clip(card.context.trim(), 1_200),
    card.answerable ? "" : t.answerInT3,
    card.link === null ? "" : `${t.openInT3} ${card.link}`,
  ];
  return lines.filter((line) => line !== "").join("\n\n");
}
