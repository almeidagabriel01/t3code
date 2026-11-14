import { MEMORY_REDACTION_MARKER, redactMemoryText } from "../memory/MemorySecretScanner.ts";

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

/** Channel text with every credential it can recognize replaced by a fixed marker. */
export function redactChannelText(text: string): string {
  return redactMemoryText({ text })
    .text.replace(ASSIGNMENT, (match, key: string, separator: string, value: string) =>
      looksSecret(value) ? `${key}${separator}${MARK}` : match,
    )
    .replace(AUTH_HEADER, (_match, scheme: string) => `${scheme} ${MARK}`)
    .replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${MARK}@`);
}

export const containsSecret = (text: string): boolean => redactChannelText(text) !== text;
