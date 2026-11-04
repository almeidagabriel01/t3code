import { assert, describe, expect, it } from "@effect/vitest";
import { WS_METHODS, type TelegramChannelSettings } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import {
  applyTelegramStatusEvent,
  compactTelegramUserId,
  createTelegramChannelEnvironmentAtoms,
  telegramDeliveryErrorReason,
  telegramStatusLabel,
  telegramSenderLabel,
  telegramSwitchHint,
} from "./telegramChannel.ts";

const settings: TelegramChannelSettings = {
  enabled: true,
  tokenConfigured: true,
  allowedUserIds: ["111"],
  botUsername: "my_bot",
  status: "error",
  lastError: "invalid_token",
};

describe("applyTelegramStatusEvent", () => {
  it("replaces status and errors, and keeps the stored fields and the bot name", () => {
    assert.deepStrictEqual(
      applyTelegramStatusEvent(settings, {
        status: "error",
        lastError: "conflict",
        lastDeliveryError: { code: "timeout", at: "2026-10-01T00:00:00.000Z" },
      }),
      {
        enabled: true,
        tokenConfigured: true,
        allowedUserIds: ["111"],
        botUsername: "my_bot",
        status: "error",
        lastError: "conflict",
        lastDeliveryError: { code: "timeout", at: "2026-10-01T00:00:00.000Z" },
      },
    );
    const waiting = [{ userId: "9", firstName: "Bo", lastSeenAt: "2026-10-01T00:00:00.000Z" }];
    const withWaiting = applyTelegramStatusEvent(settings, {
      status: "running",
      pendingSenders: waiting,
    });
    assert.deepStrictEqual(withWaiting.pendingSenders, waiting);
    assert.isUndefined(applyTelegramStatusEvent(withWaiting, { status: "running" }).pendingSenders);
    const { lastError: _gone, ...withoutError } = settings;
    assert.deepStrictEqual(
      applyTelegramStatusEvent(settings, { status: "running", botUsername: "other_bot" }),
      { ...withoutError, status: "running", botUsername: "other_bot" },
    );
    const { botUsername: _name, ...unnamed } = withoutError;
    assert.deepStrictEqual(applyTelegramStatusEvent(unnamed, { status: "disabled" }), {
      ...unnamed,
      status: "disabled",
    });
  });
});

describe("labels", () => {
  it("names the state and the reason a person can act on", () => {
    assert.strictEqual(telegramStatusLabel({ status: "disabled" }), "Off");
    assert.strictEqual(telegramStatusLabel({ status: "running" }), "Connected");
    for (const code of ["invalid_token", "conflict", "unreachable", "rate_limited"] as const) {
      assert.notStrictEqual(
        telegramStatusLabel({ status: "error", lastError: code }),
        telegramStatusLabel({ status: "error" }),
      );
    }
    assert.include(telegramStatusLabel({ status: "error" }), "bot token");
    assert.include(
      telegramDeliveryErrorReason({ code: "chat_not_found" }),
      "send the bot a message",
    );
    assert.strictEqual(
      telegramDeliveryErrorReason({ code: "automation_denied" }),
      "of an unknown error",
    );
  });

  it("needs only the token before the switch can be turned on", () => {
    assert.strictEqual(
      telegramSwitchHint({ tokenConfigured: false }),
      "Add the bot token before turning this on.",
    );
    assert.isNull(telegramSwitchHint({ tokenConfigured: true }));
  });

  it("names a waiting sender by first name, @username or id", () => {
    assert.strictEqual(telegramSenderLabel({ userId: "1", firstName: "Ana" }), "Ana");
    assert.strictEqual(telegramSenderLabel({ userId: "1", username: "ana" }), "@ana");
    assert.strictEqual(telegramSenderLabel({ userId: "1" }), "1");
  });

  it("keeps only the digits of a typed user id", () => {
    assert.strictEqual(compactTelegramUserId(" 12 34-5a "), "12345");
  });
});

describe("createTelegramChannelEnvironmentAtoms", () => {
  it("builds the settings query, status stream and the guarded configure command", () => {
    const atoms = createTelegramChannelEnvironmentAtoms(Atom.runtime(Layer.empty) as never);
    expect(Object.keys(atoms).sort()).toEqual(["configure", "settings", "status"]);
    expect(atoms.settings({ environmentId: "hub" as never, input: {} })).toBeDefined();
    expect(atoms.status({ environmentId: "hub" as never, input: null })).toBeDefined();
    expect(atoms.configure.permissionAtom("hub" as never)).toBeDefined();
    expect(WS_METHODS.telegramChannelConfigure).toBe("telegramChannel.configure");
  });
});
