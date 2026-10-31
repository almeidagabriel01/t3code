import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SlackChannelConfigureInput, SlackChannelSettingsError } from "./slackChannel.ts";

const decode = Schema.decodeUnknownSync(SlackChannelConfigureInput);

describe("SlackChannelConfigureInput", () => {
  it("accepts partial updates and channel ids, and rejects other ids and blank tokens", () => {
    assert.deepStrictEqual(decode({}), {});
    assert.deepStrictEqual(decode({ allowedChannelIds: ["C0123456789", "G0123456789"] }), {
      allowedChannelIds: ["C0123456789", "G0123456789"],
    });
    for (const bad of ["U0123456789", "c0123456789", "C123", "#general"])
      assert.throws(() => decode({ allowedChannelIds: [bad] }));
    assert.throws(() => decode({ botToken: "  " }));
  });

  it("settings errors carry a fixed message", () => {
    assert.strictEqual(
      new SlackChannelSettingsError({ reason: "invalid_token" }).message,
      "Slack rejected the token.",
    );
  });
});
