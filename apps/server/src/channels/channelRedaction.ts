import type { ProjectId } from "@t3tools/contracts";
import { projectNoticeTitle } from "@t3tools/shared/projectNotice";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MEMORY_REDACTION_MARKER, redactMemoryText } from "../memory/MemorySecretScanner.ts";
import type { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import type { ProjectService } from "../project/ProjectService.ts";

const MARK = MEMORY_REDACTION_MARKER;
// Chat apps are third-party servers: on top of the token formats memory blocks, everything the
// outbox sends drops credentials written as assignments, auth headers and URL userinfo.
// Starts only where a name starts, with bounded parts: otherwise "a.a.a…" or "token.token…"
// backtracks quadratically.
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,40}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]{0,40})(["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi;
const AUTH_HEADER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

const mixesLetters = (value: string) => /[A-Za-z]/.test(value) && /[^A-Za-z]/.test(value);
// Code, not a credential: `string`, `Token`, `z.string()`, `MAX_TOKENS`.
const CODE_NAME = /^[A-Za-z_$]+(?:\.[A-Za-z_$]+)*(?:\(\))?$/;
/** A value shaped like a credential: long when quoted, or letters mixed with digits or symbols. */
const looksSecret = (value: string) => {
  const quoted = /^(["']).*\1$/.test(value);
  const inner = quoted ? value.slice(1, -1) : value;
  return (quoted && inner.length >= 8) || (mixesLetters(inner) && !CODE_NAME.test(inner));
};

// Markdown shows `ghp\_abc` as `ghp_abc`. Between letters or digits these escapes change nothing
// on screen (no `~`: GFM strikes through on one tilde), so a secret is matched without them.
const INTRAWORD_ESCAPE = /(?<=[A-Za-z0-9])\\([_.+/=-])(?=[A-Za-z0-9])/g;

/** Channel text with every credential it can recognize replaced by a fixed marker. */
export function redactChannelText(text: string): string {
  const unescaped = text.replace(INTRAWORD_ESCAPE, "$1");
  const redacted = redactUnescaped(unescaped);
  return redacted === unescaped ? text : redacted;
}

function redactUnescaped(text: string): string {
  return redactMemoryText({ text })
    .text.replace(ASSIGNMENT, (match, key: string, separator: string, value: string) =>
      looksSecret(value) ? `${key}${separator}${MARK}` : match,
    )
    .replace(AUTH_HEADER, (_match, scheme: string) => `${scheme} ${MARK}`)
    .replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${MARK}@`);
}

export const containsSecret = (text: string): boolean => redactChannelText(text) !== text;

/** A project's title as a chat app shows it: one line, no credentials; none when that is empty. */
export const channelProjectTitle = (title: string | undefined): string | undefined => {
  const shown = title === undefined ? "" : redactChannelText(projectNoticeTitle(title));
  return shown === "" ? undefined : shown;
};

/** The title to show for a project: none for no project, an unknown one or the assistants home. */
export const channelProjectTitleOf = (
  services: {
    readonly projects: ProjectService["Service"];
    readonly folders: ManagedProjectFolders["Service"];
  },
  projectId: ProjectId | null | undefined,
): Effect.Effect<string | undefined> =>
  projectId === null || projectId === undefined
    ? Effect.undefined
    : Effect.gen(function* () {
        if (yield* services.folders.isAssistantHomeProject(projectId)) return undefined;
        const project = yield* services.projects.getById(projectId);
        return channelProjectTitle(Option.isSome(project) ? project.value.title : undefined);
      }).pipe(Effect.catchCause(() => Effect.undefined));
