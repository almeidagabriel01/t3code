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
const rules = [
  ["pem_private_key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  [
    "provider_token",
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  ],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
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
const redactions = [
  // The scanner flags the header; redaction also drops the key body that follows it.
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/g,
  ...rules.slice(1).map(([, pattern]) => new RegExp(pattern.source, "g")),
];
const redactString = (text: string) =>
  redactions.reduce((acc, pattern) => acc.replace(pattern, MEMORY_REDACTION_MARKER), text);

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
