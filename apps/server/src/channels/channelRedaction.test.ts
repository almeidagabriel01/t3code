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
    [
      "git clone https://bob:ghp_x@github.com/acme/app",
      "git clone https://[redacted]@github.com/acme/app",
    ],
    ["token: ghp_abcdefghijklmnopqrstuvwxyz0123", "token: [redacted]"],
    ["-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----", "[redacted]"],
    ["AKIAABCDEFGHIJKLMNOP in the log", "[redacted] in the log"],
  ])("redacts %s", (input, expected) => {
    expect(redactChannelText(input)).toBe(expected);
    expect(containsSecret(input)).toBe(true);
  });

  it.each([
    "vp test run apps/server/src/autonomy",
    "Rename tokenizer.ts to lexer.ts",
    "The password field is now required.",
    "https://github.com/acme/app/pull/42",
  ])("leaves ordinary text alone: %s", (input) => {
    expect(redactChannelText(input)).toBe(input);
    expect(containsSecret(input)).toBe(false);
  });
});
