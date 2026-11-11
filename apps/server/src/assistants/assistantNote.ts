import type { Assistant, AssistantTeam, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AssistantDirectoryShape } from "./AssistantDirectory.ts";
import {
  HOST_CONTAINER_NOTE_LINE,
  projectScopeNoteLine,
  sandboxNoteLine,
} from "./AssistantSandboxPolicy.ts";

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Never closes the block early, whatever the user typed into the instructions. */
const escapeBody = (value: string) => value.replace(/<\/t3_assistant/gi, "<\\/t3_assistant");

type Colleague = Pick<Assistant, "name" | "handle" | "threadId">;

const colleague = (other: Colleague) =>
  `${other.name} (@${other.handle}, threadId ${other.threadId ?? "none yet"})`;

export interface TeamMembership {
  readonly team: Pick<AssistantTeam, "name">;
  readonly lead: Colleague | null;
  readonly teammates: ReadonlyArray<Colleague & { readonly role?: string | undefined }>;
}

const TEAM_GUIDANCE =
  "These are your teammates; you may hand work to any of them with t3_thread_send to its threadId. Do not wait: send, then end your turn. The answer arrives later as a new message in this conversation. When a teammate's request carries a requestId, answer it with t3_thread_send to the asker's threadId and replyTo set to that requestId, as Status (done | partial | blocked), Result, Evidence, and Unblock when blocked; never reply to a reply. Message one only when the work needs them, and keep exchanges short. When the user asks you to post in a group's chat, use t3_assistant group_post instead; members answer in that chat, not here. Summarize for the user what the group did.";

/** One block per group the assistant is in; empty when it is in none. */
function teamsLines(self: Pick<Colleague, "handle">, teams: ReadonlyArray<TeamMembership>): string {
  if (teams.length === 0) return "";
  const lines = teams.map(({ team, lead, teammates }) => {
    const members = teammates
      .map((mate) => (mate.role ? `${colleague(mate)}, ${mate.role}` : colleague(mate)))
      .join("; ");
    const leadLine =
      lead === null
        ? ""
        : lead.handle === self.handle
          ? " You route group requests that mention no one."
          : ` ${lead.name} routes group requests that mention no one.`;
    return `Group "${team.name}": ${members}.${leadLine}`;
  });
  return escapeBody([...lines, TEAM_GUIDANCE].join("\n"));
}

const TASKS_FOLLOW =
  "It carries your instructions, model and access. You are woken when it finishes, so never wait on it. Then check its diff, run the tests, ask a teammate to review when that helps, send fixes with t3_thread_send, and only then tell the user. Dismiss a finished task (t3_assistant task_dismiss) only when the user asks to clear it, never on your own and never one whose result you have not told them.";
const TASKS_HOST = `Do quick things yourself, here: a question, a lookup, a small tweak. Real multi-step code work (changing several files, adding tests, running a suite) is never done in this conversation: start a thread for it with t3_thread_launch in the right project, with a full brief of goal, files, constraints and how to verify. ${TASKS_FOLLOW}`;
const TASKS_SANDBOX = `Any change to files, and any command that changes anything, is work for a thread, never for this conversation: start it with t3_thread_launch in your sandbox, with a full brief of goal, files, constraints and how to verify. ${TASKS_FOLLOW}`;

const ASK_BEFORE_ACTING_LINE =
  "Ask before acting is on: a message you send into another agent conversation is held until the user approves it in this conversation. If a send says it is waiting for approval, tell the user it is waiting and stop; send the same message again only after they approve, and never send it another way if they decline.";

export function assistantNoteFor(
  assistant: Pick<Assistant, "name" | "handle" | "toolAccess" | "instructions" | "role"> & {
    readonly askBeforeActing?: boolean | undefined;
    readonly workspace?: Assistant["workspace"] | undefined;
    readonly scope?: Assistant["scope"] | undefined;
    readonly projectIds?: ReadonlyArray<string> | undefined;
  },
  userText: string,
  teams: ReadonlyArray<TeamMembership> = [],
  /** The sandbox's environment id; null while it is not linked. Read only for a sandboxed assistant. */
  sandboxEnvironmentId: string | null = null,
  projectTitles: Readonly<Record<string, string>> = {},
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
    teamsLines(assistant, teams),
    assistant.workspace === "sandbox"
      ? sandboxNoteLine(sandboxEnvironmentId)
      : HOST_CONTAINER_NOTE_LINE,
    assistant.scope === "project"
      ? escapeBody(projectScopeNoteLine(assistant.projectIds ?? [], projectTitles))
      : "",
    assistant.workspace === "sandbox" ? TASKS_SANDBOX : TASKS_HOST,
    assistant.askBeforeActing === true ? ASK_BEFORE_ACTING_LINE : "",
    escapeBody(assistant.instructions.trim()),
  ]
    .filter((part) => part !== "")
    .join("\n");
  return body === "" ? `${open}\n</t3_assistant>` : `${open}\n${body}\n</t3_assistant>`;
}

/** The note of a thread an assistant launched: its instructions travel with the work. */
function assistantTaskNoteFor(
  assistant: Pick<Assistant, "name" | "handle" | "instructions">,
  userText: string,
): string {
  if (userText.trimStart().startsWith("/")) return "";
  const open = `<t3_assistant_task assistant="${escapeAttribute(assistant.name)}" handle="${assistant.handle}">`;
  const body = [
    `${assistant.name} launched this thread and reviews its result. Finish with what you changed, what you ran and what is left.`,
    escapeBody(assistant.instructions.trim()),
  ]
    .filter((part) => part !== "")
    .join("\n");
  return `${open}\n${body}\n</t3_assistant_task>`;
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
  if (Option.isNone(found)) {
    const owner = yield* directory.value.taskOwner(threadId);
    return Option.isNone(owner) ? "" : assistantTaskNoteFor(owner.value, userText);
  }
  const { assistant } = found.value;
  const teams = userText.trimStart().startsWith("/")
    ? []
    : yield* directory.value.teamsOf(assistant);
  const sandbox =
    assistant.workspace === "sandbox"
      ? Option.getOrNull(yield* directory.value.sandboxEnvironmentId)
      : null;
  const titles =
    assistant.scope === "project" && directory.value.projectTitles !== undefined
      ? yield* directory.value.projectTitles(assistant.projectIds)
      : {};
  return assistantNoteFor(assistant, userText, teams, sandbox, titles);
});
