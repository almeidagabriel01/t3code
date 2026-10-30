import { assert, describe, it } from "@effect/vitest";
import * as M from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  MEMORY_REDACTION_MARKER,
  redacted,
  redactMemoryText,
  scanMemoryValue,
} from "./MemorySecretScanner.ts";

const decodePayload = Schema.decodeUnknownSync(M.MemoryPayload);

describe("MemorySecretScanner", () => {
  it("blocks fabricated tokens and PEM private keys", () => {
    const sentinel = "sk-" + "A".repeat(32);
    const result = scanMemoryValue({ text: sentinel, judgment: "-----BEGIN PRIVATE KEY-----" });
    assert.deepStrictEqual(result.kind === "blocked" ? result.ruleIds : [], [
      "pem_private_key",
      "provider_token",
    ]);
    assert.notInclude(JSON.stringify(result), sentinel);
  });
  it("screens input output judgment and originals", () => {
    const sentinel = "ghp_" + "Z".repeat(32);
    for (const field of ["payload", "result", "inputs", "originals", "resolutionPayload"])
      assert.strictEqual(
        scanMemoryValue({ [field]: [{ text: sentinel, judgment: sentinel }] }).kind,
        "blocked",
      );
    assert.strictEqual(scanMemoryValue({ messages: [{ text: sentinel }] }).kind, "blocked");
  });
  it("allows ordinary memory prose", () => {
    assert.deepStrictEqual(
      scanMemoryValue({ text: "Prefer targeted checks. Keep the default model options." }),
      { kind: "allowed" },
    );
    assert.deepStrictEqual(scanMemoryValue({ environmentId: "sk-" + "A".repeat(32) }), {
      kind: "allowed",
    });
  });
  it("unknown secret-bearing fields cannot enter operation encoding", () => {
    const payload = {
      text: "ordinary",
      evidence: [],
      derivedFromMemoryRevisions: [],
      secret: "sk-" + "A".repeat(32),
    };
    assert.throws(() => decodePayload(payload, { onExcessProperty: "error" }));
  });
  it("pre-admission blocked operation keeps metadata only", () => {
    const sentinel = "xoxb-" + "A".repeat(32);
    const result = scanMemoryValue({ payload: { text: sentinel } });
    assert.strictEqual(result.kind, "blocked");
    assert.notInclude(JSON.stringify(result), sentinel);
    assert.deepStrictEqual(Object.keys(result).sort(), ["inspectedBytes", "kind", "ruleIds"]);
  });
});

describe("memory redaction", () => {
  const secrets = {
    provider_token: "sk-" + "A".repeat(32),
    github: "ghp_" + "Z".repeat(32),
    aws: "AKIA" + "B".repeat(16),
    slack: "xoxb-" + "C".repeat(24),
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEBODY\n-----END RSA PRIVATE KEY-----",
  };
  it.each(Object.entries(secrets))(
    "replaces %s in text and judgment, leaving a scan-clean value",
    (_label, secret) => {
      const value = redactMemoryText({
        text: `use ${secret} here`,
        judgment: `also ${secret}`,
        evidence: "kept",
      });
      assert.strictEqual(value.text, `use ${MEMORY_REDACTION_MARKER} here`);
      assert.strictEqual(value.judgment, `also ${MEMORY_REDACTION_MARKER}`);
      assert.strictEqual(scanMemoryValue(value).kind, "allowed");
    },
  );
  it("leaves ordinary text untouched and keeps judgment absent", () => {
    const value = { text: "Prefer targeted checks." };
    assert.deepStrictEqual(redactMemoryText(value), value);
  });
  it.effect("redacted() scrubs content fields of a generation result only", () =>
    Effect.gen(function* () {
      const out = yield* redacted(
        Effect.succeed({
          execution: { id: secrets.provider_token },
          result: { text: secrets.github, assertionKind: "inference" },
        }),
      );
      assert.deepStrictEqual(out, {
        execution: { id: secrets.provider_token },
        result: { text: MEMORY_REDACTION_MARKER, assertionKind: "inference" },
      });
    }),
  );
});
