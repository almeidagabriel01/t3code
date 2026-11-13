import { assistantGroupAddress, foldAssistantGroupText } from "@t3tools/contracts";

/** A short "keep going" with no subject: it resumes the stopped work instead of starting new. */
const CONTINUE =
  /^(?:please |por favor |pode )?(?:continue|continua|continuar|go on|keep going|carry on|proceed|resume|retoma|retomar|segue|prossiga|prossegue)(?: please| por favor| ai| ae)?$/;

export const isContinueRequest = (text: string): boolean =>
  CONTINUE.test(
    foldAssistantGroupText(text)
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

type GroupRoute =
  | { readonly kind: "members"; readonly ids: ReadonlyArray<string> }
  | { readonly kind: "resume"; readonly taskId: string };

/**
 * What a user message does before any model is asked, first match wins: the members it names, the
 * owner of the message it replies to, a bare "continue" that resumes the newest stopped task, the
 * one member working the request it continues, then a group of one. Null leaves it to the lead. A
 * message that replies to nothing is a new request, so it never follows up on whatever is open.
 */
export function routeGroupMessage(input: {
  readonly text: string;
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly handle: string;
    readonly name: string;
  }>;
  /** Owner of the member message being replied to, when it is still a member. */
  readonly replyOwnerId: string | null;
  /** Paused or failed root tasks, newest first: of the request replied to, else of the group. */
  readonly stopped: ReadonlyArray<{ readonly taskId: string; readonly ownerId: string }>;
  /** Only the user's own words resume or follow up; agents and schedules go to the lead. */
  readonly fromUser: boolean;
  /** The member, when only one works the request the message continues. */
  readonly requestOwnerId?: string | null;
}): GroupRoute | null {
  const named = assistantGroupAddress(input.text, input.members);
  if (named !== null) return { kind: "members", ids: named.map((member) => member.id) };
  if (input.replyOwnerId !== null) return { kind: "members", ids: [input.replyOwnerId] };
  if (input.fromUser && isContinueRequest(input.text)) {
    const present = new Set(input.members.map((member) => member.id));
    const task = input.stopped.find((candidate) => present.has(candidate.ownerId));
    if (task !== undefined) return { kind: "resume", taskId: task.taskId };
  }
  const requestOwner = input.requestOwnerId ?? null;
  if (
    input.fromUser &&
    requestOwner !== null &&
    input.members.some((member) => member.id === requestOwner)
  ) {
    return { kind: "members", ids: [requestOwner] };
  }
  if (input.members.length === 1) return { kind: "members", ids: [input.members[0]!.id] };
  return null;
}
