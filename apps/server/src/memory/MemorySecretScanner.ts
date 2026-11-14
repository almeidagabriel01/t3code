import * as Effect from "effect/Effect";

/** Scanner reports rule identifiers only; inspected strings never leave this boundary. */
export type MemoryScanResult =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "blocked";
      readonly ruleIds: ReadonlyArray<string>;
      readonly inspectedBytes: number;
    };

export const MEMORY_SCANNER_POLICY_VERSION = 1;
// PEM (RSA, EC, OpenSSH, PKCS#8…) and OpenPGP armor all name the key in the header line.
const PRIVATE_KEY_LABEL = String.raw`[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?`;
const rules = [
  ["pem_private_key", new RegExp(`-----BEGIN ${PRIVATE_KEY_LABEL}-----`)],
  [
    "provider_token",
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|whsec_[A-Za-z0-9+/]{24,}={0,2}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}|SK[0-9a-f]{32})(?![A-Za-z0-9_-])/,
  ],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["slack_token", /\bx(?:ox[baprs]|app)-[A-Za-z0-9-]{20,}\b/],
  [
    "slack_webhook",
    /\bhooks\.slack\.com\/services\/T[A-Za-z0-9]{8,}\/B[A-Za-z0-9]{8,}\/[A-Za-z0-9]{20,}/,
  ],
  // Azure Storage connection strings; the key name stays readable after redaction.
  ["azure_storage_key", /(?<=\bAccountKey=)[A-Za-z0-9+/]{40,}={0,2}/],
  // Base64 user id, timestamp, HMAC.
  [
    "discord_bot_token",
    /(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}(?![A-Za-z0-9_-])/,
  ],
  // Three base64url parts, the first a JSON header ("{" encodes as "eyJ").
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/],
  // Bot API URLs glue the token to "bot" (…/bot<id>:<secret>/getMe).
  [
    "telegram_bot_token",
    /(?:(?<=\bbot)|(?<![A-Za-z0-9_-]))\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  ],
] as const;
// Authority/provenance IDs are validated by strict codecs, not scanned as prose.
const contentFields = new Set([
  "text",
  "judgment",
  "messages",
  "payload",
  "payloads",
  "resolutionPayload",
  "originals",
  "inputs",
  "result",
]);
export function scanMemoryValue(value: unknown): MemoryScanResult {
  const found = new Set<string>();
  let inspectedBytes = 0;
  const inspect = (input: unknown, content: boolean): void => {
    if (typeof input === "string") {
      if (!content) return;
      inspectedBytes += new TextEncoder().encode(input).length;
      for (const [id, pattern] of rules) if (pattern.test(input)) found.add(id);
    } else if (Array.isArray(input)) {
      for (const child of input) inspect(child, content);
    } else if (input !== null && typeof input === "object") {
      for (const [key, child] of Object.entries(input)) inspect(child, contentFields.has(key));
    }
  };
  inspect(value, typeof value === "string");
  return found.size === 0
    ? { kind: "allowed" }
    : { kind: "blocked", ruleIds: [...found].sort(), inspectedBytes };
}

export const MEMORY_REDACTION_MARKER = "[redacted]";
const MARK = MEMORY_REDACTION_MARKER;
/**
 * Credentials only their context identifies. They are redacted, never blocked on: the context words
 * ("Cookie:", "mysql") appear in ordinary notes, so each pattern also asks for a value shaped like one.
 */
const contextual: ReadonlyArray<
  readonly [RegExp, (match: string, ...groups: Array<string>) => string]
> = [
  // A header value of one long token, with or without a scheme ("Authorization: abc…", "Basic …").
  [
    /\b((?:Proxy-)?Authorization)(\s*:\s*)(?:[A-Za-z]+\s+)?[A-Za-z0-9._~+/=-]{16,}/gi,
    (_m, name, separator) => `${name}${separator}${MARK}`,
  ],
  // Only a header that carries name=value pairs, not the word "Cookie:" in prose.
  [
    /\b((?:Set-)?Cookie)(\s*:\s*)[^\s=;:]+=[^\r\n]*/gi,
    (_m, name, separator) => `${name}${separator}${MARK}`,
  ],
  // `-p<password>` glued to the flag; a bare `-p` asks for it interactively. Bounded: a line of
  // repeated "mysql" with no flag is otherwise quadratic.
  [
    /\b(mysql(?:dump|admin|sh)?\b[^\n]{0,200}?\s-p)(?=\S)[^\s]+/g,
    (_m, prefix) => `${prefix}${MARK}`,
  ],
];
const redactions: ReadonlyArray<RegExp> = [
  // The scanner flags the header; redaction also drops the key body that follows it.
  new RegExp(
    `-----BEGIN ${PRIVATE_KEY_LABEL}-----[\\s\\S]*?(?:-----END ${PRIVATE_KEY_LABEL}-----|$)`,
    "g",
  ),
  ...rules.slice(1).map(([, pattern]) => new RegExp(pattern.source, "g")),
];
const redactString = (text: string) =>
  contextual.reduce(
    (acc, [pattern, replace]) => acc.replace(pattern, replace),
    redactions.reduce((acc, pattern) => acc.replace(pattern, MARK), text),
  );

/** Replaces every secret the scanner detects in memory text with a fixed marker. */
export const redactMemoryText = <T extends { readonly text: string; readonly judgment?: string }>(
  value: T,
): T => ({
  ...value,
  text: redactString(value.text),
  ...(value.judgment === undefined ? {} : { judgment: redactString(value.judgment) }),
});

const redactValue = (input: unknown, content: boolean): unknown =>
  typeof input === "string"
    ? content
      ? redactString(input)
      : input
    : Array.isArray(input)
      ? input.map((child) => redactValue(child, content))
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input).map(([key, child]) => [
              key,
              redactValue(child, contentFields.has(key)),
            ]),
          )
        : input;

/** A generation whose result has secrets in content fields replaced before anything reads it. */
export const redacted = <O, E, R>(generation: Effect.Effect<O, E, R>): Effect.Effect<O, E, R> =>
  Effect.map(generation, (output) => redactValue(output, false) as O);
