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
 * owner of the message it replies to, a bare "continue" that resumes the newest stopped task, a
 * follow-up while exactly one task is open (its owner gets it), then a group of one. Null leaves
 * it to the lead.
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
  /** Paused or failed root tasks, newest first. */
  readonly stopped: ReadonlyArray<{ readonly taskId: string; readonly ownerId: string }>;
  /** Owners of the root tasks queued, running or waiting (one request counts once). */
  readonly open: ReadonlyArray<string>;
  /** Only the user's own words resume or follow up; agents and schedules go to the lead. */
  readonly fromUser: boolean;
}): GroupRoute | null {
  const named = assistantGroupAddress(input.text, input.members);
  if (named !== null) return { kind: "members", ids: named.map((member) => member.id) };
  if (input.replyOwnerId !== null) return { kind: "members", ids: [input.replyOwnerId] };
  if (input.fromUser) {
    if (isContinueRequest(input.text)) {
      const present = new Set(input.members.map((member) => member.id));
      const task = input.stopped.find((candidate) => present.has(candidate.ownerId));
      if (task !== undefined) return { kind: "resume", taskId: task.taskId };
    }
    if (input.open.length === 1 && input.members.some((member) => member.id === input.open[0])) {
      return { kind: "members", ids: [input.open[0]!] };
    }
  }
  if (input.members.length === 1) return { kind: "members", ids: [input.members[0]!.id] };
  return null;
}
