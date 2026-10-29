import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderSessionRestartNotice } from "./providerSessionRestart.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const provider = {
  instanceId,
  driver: "claudeAgent",
  displayName: "Claude",
  version: "2.1.1",
} as never;
const session = (overrides: Record<string, unknown> = {}) =>
  ({
    providerInstanceId: instanceId,
    providerVersion: "2.1.0",
    status: "ready",
    capabilities: { sessions: { supportsMultipleProviderThreadsPerSession: false } },
    updatedAt: DateTime.makeUnsafe(0),
    ...overrides,
  }) as never;
const derive = (sessions: ReadonlyArray<never>, running = false, installed = provider) =>
  deriveProviderSessionRestartNotice({ sessions, providers: [installed], running });

describe("deriveProviderSessionRestartNotice", () => {
  it.each([
    ["an older live session", [session()], false, { installedVersion: "2.1.1", blocked: null }],
    ["a turn running", [session()], true, { blocked: "running" }],
    [
      "a session shared by threads",
      [
        session({
          capabilities: { sessions: { supportsMultipleProviderThreadsPerSession: true } },
        }),
      ],
      false,
      { blocked: "shared" },
    ],
  ])("notices %s", (_name, sessions, running, expected) => {
    expect(derive(sessions, running)).toMatchObject(expected);
  });

  it("compares versions with suffixes and ignores an unparseable installed one", () => {
    const withVersion = (version: string | null) => ({ ...(provider as object), version }) as never;
    expect(
      derive(
        [session({ providerVersion: "2.1.0 (Claude Code)" })],
        false,
        withVersion("2.1.1-beta.1"),
      ),
    ).toMatchObject({ installedVersion: "2.1.1-beta.1" });
    expect(derive([session()], false, withVersion("garbage"))).toBeNull();
  });

  it.each([
    ["the same version", [session({ providerVersion: "v2.1.1" })]],
    ["the same version with a suffix", [session({ providerVersion: "2.1.1 (Claude Code)" })]],
    ["a newer session than installed", [session({ providerVersion: "2.2.0" })]],
    ["an unparseable version", [session({ providerVersion: "nightly" })]],
    ["an unreported version", [session({ providerVersion: undefined })]],
    ["a released session", [session({ status: "stopped" })]],
  ])("stays quiet for %s", (_name, sessions) => {
    expect(derive(sessions)).toBeNull();
  });
});
