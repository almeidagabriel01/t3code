import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ClaudeChromeStatus,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";

import type { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { runClaudeChrome } from "./claudeChromeRpc.ts";

const kind = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("any");
const status: ClaudeChromeStatus = {
  instanceId,
  enabledByDefault: true,
  launchOverride: null,
  effective: true,
  extensionInstalled: null,
  pairedBrowser: null,
  sharedConfig: false,
};
const registryOf = (instance: Partial<ProviderInstance> | undefined) =>
  ({
    getInstance: () => Effect.succeed(instance as ProviderInstance | undefined),
  }) as unknown as ProviderInstanceRegistry["Service"];
const claudeChrome = {
  status: Effect.succeed(status),
  setDefault: () => Effect.succeed(status),
};

describe("runClaudeChrome", () => {
  const refusals = [
    { name: "missing instance", instance: undefined, detail: "Provider instance not found." },
    {
      name: "disabled instance",
      instance: { enabled: false, claudeChrome },
      detail: "This provider is disabled.",
    },
    {
      name: "non-Claude instance",
      instance: { enabled: true },
      detail: "Claude in Chrome is only available on Claude instances.",
    },
  ];
  it.effect.each(refusals)("refuses a $name", ({ instance, detail }) =>
    Effect.gen(function* () {
      const error = yield* runClaudeChrome(
        registryOf(instance),
        instanceId,
        (chrome) => chrome.status,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProviderSetupError);
      expect(error.detail).toBe(detail);
    }),
  );

  it.effect("maps a driver failure to a setup error carrying its detail", () =>
    Effect.gen(function* () {
      const failing = {
        ...claudeChrome,
        setDefault: () =>
          Effect.fail(new ProviderDriverError({ driver: kind, instanceId, detail: "bad file" })),
      };
      const error = yield* runClaudeChrome(
        registryOf({ enabled: true, claudeChrome: failing }),
        instanceId,
        (chrome) => chrome.setDefault(true),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProviderSetupError);
      expect(error.detail).toBe("bad file");
    }),
  );

  it.effect("returns the driver status for a Claude instance", () =>
    Effect.gen(function* () {
      expect(
        yield* runClaudeChrome(
          registryOf({ enabled: true, claudeChrome }),
          instanceId,
          (chrome) => chrome.status,
        ),
      ).toEqual(status);
    }),
  );
});
