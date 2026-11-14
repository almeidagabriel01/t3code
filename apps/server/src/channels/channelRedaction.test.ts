import { describe, expect, it } from "vite-plus/test";

import { containsSecret, redactChannelText } from "./channelRedaction.ts";

describe("redactChannelText", () => {
  it.each([
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx", "export OPENAI_API_KEY=[redacted]"],
    [
      "curl -H 'Authorization: Bearer abc.def.ghi123'",
      "curl -H 'Authorization: Bearer [redacted]'",
    ],
    ["PGPASSWORD='hunter22' psql", "PGPASSWORD=[redacted] psql"],
    ['{"client_secret": "s3cr3t"}', '{"client_secret": [redacted]}'],
    ['password: "hunter2xyz"', "password: [redacted]"],
    ["API_KEY=a1b2c3d4e5", "API_KEY=[redacted]"],
    [
      "git clone https://bob:ghp_x@github.com/acme/app",
      "git clone https://[redacted]@github.com/acme/app",
    ],
    ["token: ghp_abcdefghijklmnopqrstuvwxyz0123", "token: [redacted]"],
    ["-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----", "[redacted]"],
    ["AKIAABCDEFGHIJKLMNOP in the log", "[redacted] in the log"],
    [`Markdown-escaped ghp\\_${"Z".repeat(32)} here`, "Markdown-escaped [redacted] here"],
    [`sk\\-proj\\-${"a".repeat(24)}`, "[redacted]"],
  ])("redacts %s", (input, expected) => {
    expect(redactChannelText(input)).toBe(expected);
    expect(containsSecret(input)).toBe(true);
  });

  it.each([
    "vp test run apps/server/src/autonomy",
    "Rename tokenizer.ts to lexer.ts",
    "The password field is now required.",
    "https://github.com/acme/app/pull/42",
    "interface X { apiKey: string; token: Token }",
    "max_tokens: 4096",
    "secret: z.string()",
    "// token: the session",
    "snake\\_case and 1\\.5 keep their escapes",
  ])("leaves ordinary text alone: %s", (input) => {
    expect(redactChannelText(input)).toBe(input);
    expect(containsSecret(input)).toBe(false);
  });

  it.each(["a.".repeat(100_000), "token.".repeat(40_000)])(
    "stays linear on adversarial input (%#)",
    (input) => {
      // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- ReDoS bound: the quadratic form takes seconds, linear well under 100 ms
      const started = performance.now();
      redactChannelText(input);
      // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- see above
      expect(performance.now() - started).toBeLessThan(100);
    },
  );
});
