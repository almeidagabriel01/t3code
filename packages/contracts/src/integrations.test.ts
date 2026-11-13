import { expect, it } from "vite-plus/test";

import { type DetectedServer, integrationProviderSupport, loadedNatively } from "./integrations.ts";

const detected = (overrides: Partial<DetectedServer>): DetectedServer => ({
  id: "x",
  name: "linear",
  origin: "claude-code",
  scope: "user",
  catalogId: "linear",
  transport: "http",
  loaded: "connected",
  enabled: true,
  copyable: true,
  secretKeys: [],
  needsValue: [],
  ...overrides,
});

it.each([
  ["a connected user-scope server", {}, true],
  ["a connected claude.ai connector", { origin: "claude-ai", scope: undefined }, true],
  ["a connected plugin server", { scope: "plugin" }, true],
  ["one that needs sign-in", { loaded: "needs-auth" }, false],
  ["one that failed", { loaded: "failed" }, false],
  ["one never seen loading", { loaded: undefined }, false],
  ["a project-scope server, even connected", { scope: "project" }, false],
  ["a local-scope server, even connected", { scope: "local" }, false],
  ["an enabled Codex server", { origin: "codex", scope: undefined, loaded: undefined }, true],
  ["a disabled Codex server", { origin: "codex", scope: undefined, enabled: false }, false],
  ["a server outside the catalog", { catalogId: null }, false],
  ["T3's own server", { origin: "t3", scope: undefined }, false],
] as const)("D7 counts %s: %s", (_label, overrides, expected) => {
  expect(loadedNatively(detected(overrides as Partial<DetectedServer>))).toBe(expected);
});

it.each([
  ["claudeAgent", true],
  ["codex", true],
  ["cursor", true],
  ["antigravity", true],
  ["acpRegistry", true],
  ["grok", true],
  ["kiro", true],
  ["fx", true],
  ["opencode", false],
  ["pi", false],
  ["muse", false],
  ["remote", false],
  ["a-future-driver", false],
])("integrations reach %s: %s", (driverKind, supported) => {
  expect(integrationProviderSupport(driverKind)).toBe(supported);
});
