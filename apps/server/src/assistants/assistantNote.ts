import type { Assistant, AssistantTeam, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AssistantDirectoryShape } from "./AssistantDirectory.ts";
import { sandboxNoteLine } from "./AssistantSandboxPolicy.ts";

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Never closes the block early, whatever the user typed into the instructions. */
const escapeBody = (value: string) => value.replace(/<\/t3_assistant/gi, "<\\/t3_assistant");

type Colleague = Pick<Assistant, "name" | "handle" | "threadId">;

const colleague = (other: Colleague) =>
  `${other.name} (@${other.handle}, threadId ${other.threadId ?? "none yet"})`;

/** One line the model can act on: who to ask, who it answers to. Empty without an org relation. */
function teamLine(leader: Colleague | null, reports: ReadonlyArray<Colleague>): string {
  const parts = [
    leader === null
      ? ""
      : `You report to ${colleague(leader)}; answer them through your run result, never by messaging them.`,
    reports.length === 0 ? "" : `Your direct reports: ${reports.map(colleague).join("; ")}.`,
  ].filter((part) => part !== "");
  return escapeBody(parts.join(" "));
}

export interface TeamMembership {
  readonly team: Pick<AssistantTeam, "name" | "leaderTitle">;
  readonly leader: Colleague | null;
  readonly teammates: ReadonlyArray<Colleague & { readonly role?: string | undefined }>;
}

const TEAM_GUIDANCE =
  "Talk to a teammate with t3_thread_send to its threadId only when the work needs them, then t3_thread_wait on the run it returns. Keep exchanges short and purposeful, never reply just to acknowledge, and do not message assistants outside your teams. If a send is refused because you messaged teammates too much, stop and report to the user instead. Summarize for the user what the team did.";

/** One block per team the assistant is in; empty when it is in none. */
function teamsLines(self: Pick<Colleague, "handle">, teams: ReadonlyArray<TeamMembership>): string {
  if (teams.length === 0) return "";
  const lines = teams.map(({ team, leader, teammates }) => {
    const title = team.leaderTitle ?? "leader";
    const members = teammates
      .map((mate) => (mate.role ? `${colleague(mate)}, ${mate.role}` : colleague(mate)))
      .join("; ");
    const leaderLine =
      leader === null
        ? ""
        : leader.handle === self.handle
          ? ` You are the team's ${title}: coordinate the work and collect your teammates' results.`
          : ` ${leader.name} is the team's ${title}: report your results to them with t3_thread_send.`;
    return `Team "${team.name}": ${members}.${leaderLine}`;
  });
  return escapeBody([...lines, TEAM_GUIDANCE].join("\n"));
}

const ASK_BEFORE_ACTING_LINE =
  "Ask before acting is on: a message you send into another agent conversation is held until the user approves it in this conversation. If a send says it is waiting for approval, tell the user it is waiting and stop; send the same message again only after they approve, and never send it another way if they decline.";

export function assistantNoteFor(
  assistant: Pick<Assistant, "name" | "handle" | "toolAccess" | "instructions" | "role"> & {
    readonly askBeforeActing?: boolean | undefined;
    readonly workspace?: Assistant["workspace"] | undefined;
  },
  userText: string,
  team: { readonly leader: Colleague | null; readonly reports: ReadonlyArray<Colleague> } = {
    leader: null,
    reports: [],
  },
  teams: ReadonlyArray<TeamMembership> = [],
  /** The sandbox's environment id; null while it is not linked. Read only for a sandboxed assistant. */
  sandboxEnvironmentId: string | null = null,
): string {
  // Provider-native slash commands must stay at the start of the prompt.
  if (userText.trimStart().startsWith("/")) return "";
  const role = assistant.role === "" ? "" : ` role="${escapeAttribute(assistant.role)}"`;
  // A sandboxed assistant only reads here; its access applies to the work it starts in the sandbox.
  const access =
    assistant.workspace === "sandbox"
      ? `access="read-only" sandbox_access="${assistant.toolAccess}"`
      : `access="${assistant.toolAccess}"`;
  const open = `<t3_assistant name="${escapeAttribute(assistant.name)}" handle="${assistant.handle}"${role} ${access}>`;
  const body = [
    teamLine(team.leader, team.reports),
    teamsLines(assistant, teams),
    assistant.workspace === "sandbox" ? sandboxNoteLine(sandboxEnvironmentId) : "",
    assistant.askBeforeActing === true ? ASK_BEFORE_ACTING_LINE : "",
    escapeBody(assistant.instructions.trim()),
  ]
    .filter((part) => part !== "")
    .join("\n");
  return body === "" ? `${open}\n</t3_assistant>` : `${open}\n${body}\n</t3_assistant>`;
}

/**
 * Sent ahead of every turn of an assistant thread, not once: the instructions then survive
 * compaction, native resume and a provider switch, and an edit applies from the next turn.
 */
export const assistantNote = Effect.fn("AssistantNote.forTurn")(function* (
  directory: Option.Option<AssistantDirectoryShape>,
  threadId: ThreadId,
  userText: string,
) {
  if (Option.isNone(directory)) return "";
  const found = yield* directory.value.forThread(threadId);
  if (Option.isNone(found)) return "";
  const { assistant } = found.value;
  const team = userText.trimStart().startsWith("/")
    ? undefined
    : yield* directory.value.teamOf(assistant);
  const teams = team === undefined ? [] : yield* directory.value.teamsOf(assistant);
  const sandbox =
    assistant.workspace === "sandbox"
      ? Option.getOrNull(yield* directory.value.sandboxEnvironmentId)
      : null;
  return assistantNoteFor(assistant, userText, team, teams, sandbox);
});
