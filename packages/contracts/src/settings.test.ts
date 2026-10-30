import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { MemoryHubSettings, MemoryHubSettingsUpdateInput } from "./memory.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  requiredScopesForServerSettingsPatch,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeMemoryHubSettings = Schema.decodeSync(MemoryHubSettings);
const decodeUnknownMemoryHubSettings = Schema.decodeUnknownSync(MemoryHubSettings);
const decodeHubUpdateInput = Schema.decodeSync(MemoryHubSettingsUpdateInput);

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("ServerSettings provider budgets", () => {
  it("defaults warn threshold and blocking, and rejects non-positive amounts", () => {
    const patch = decodeServerSettingsPatch({
      providerBudgets: { a: { amountUsd: 10, period: "weekly", timeZone: "UTC" }, b: null },
    });
    expect(Object.values(patch.providerBudgets ?? {})[0]).toEqual({
      amountUsd: 10,
      period: "weekly",
      warnAtPercent: 80,
      blockWhenExceeded: false,
      timeZone: "UTC",
    });
    for (const bad of [
      { amountUsd: 0 },
      { amountUsd: -1 },
      { period: "yearly" },
      { warnAtPercent: 0 },
    ]) {
      expect(() =>
        decodeServerSettingsPatch({
          providerBudgets: { a: { amountUsd: 10, period: "daily", timeZone: "UTC", ...bad } },
        }),
      ).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings appearance", () => {
  it("defaults the appearance style and backdrop for new and older settings", () => {
    for (const payload of [{}, { glassOpacity: 60 }]) {
      const settings = decodeClientSettings(payload);
      expect(settings.appearancePreset).toBe("default");
      expect(settings.glassBackdrop).toBe("built-in");
      expect(settings.glassOpacity).toBe("glassOpacity" in payload ? 60 : 80);
    }
  });

  it("accepts Liquid Glass style patches and rejects unknown styles", () => {
    expect(decodeClientSettingsPatch({ appearancePreset: "liquid-glass" })).toEqual({
      appearancePreset: "liquid-glass",
    });
    expect(() => decodeClientSettingsPatch({ appearancePreset: "frosted" })).toThrow();
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("destination rail client settings", () => {
  it("decodes settings saved before the rail was customizable", () => {
    expect(decodeClientSettings({}).destinationRail).toEqual({ order: [], shown: [], hidden: [] });
  });

  it("still decodes settings saved with the removed Usage button toggle", () => {
    expect(decodeClientSettings({ sidebarShowUsageButton: false }).destinationRail).toEqual({
      order: [],
      shown: [],
      hidden: [],
    });
  });

  it("keeps ids this version does not know", () => {
    const saved = { order: ["future-item", "running"], shown: ["future-item"], hidden: ["usage"] };
    const settings = decodeClientSettings({ destinationRail: saved });
    expect(settings.destinationRail).toEqual(saved);
    expect(encodeClientSettings(settings).destinationRail).toEqual(saved);
  });
});

describe("right panel quick buttons client setting", () => {
  it("defaults to today's five buttons and keeps ids this version does not know", () => {
    expect(decodeClientSettings({}).rightPanelQuickButtons).toEqual([
      "files",
      "diff",
      "terminal",
      "preview",
      "pull-requests",
    ]);
    const saved = ["notes", "future-surface"];
    expect(decodeClientSettings({ rightPanelQuickButtons: saved }).rightPanelQuickButtons).toEqual(
      saved,
    );
  });
});

describe("memory hub settings", () => {
  it("defaults old settings to disabled memory hub", () => {
    expect(decodeServerSettings({}).memoryHub).toEqual({ mode: "disabled" });
    expect(decodeServerSettings({}).memoryHubVersion).toBe(0);
  });
  it("round-trips hub and member without secret bytes", () => {
    for (const memoryHub of [
      { mode: "hub", memorySpaceId: null },
      {
        mode: "member",
        hubEnvironmentId: "env",
        endpoint: "https://hub.invalid",
        secretName: "memory-hub-member",
        memorySpaceId: null,
      },
    ])
      expect(encodeServerSettings(decodeServerSettings({ memoryHub }))).toMatchObject({
        memoryHub,
      });
  });
  it("rejects credentials query and nonloopback plain HTTP in hub endpoint", () => {
    for (const endpoint of [
      "https://user:pass@hub.invalid",
      "https://hub.invalid?x=y",
      "http://hub.invalid",
      "https://hub.invalid/path",
      "https://hub.invalid#secret",
    ])
      expect(() =>
        decodeMemoryHubSettings({
          mode: "member",
          hubEnvironmentId: "env",
          endpoint,
          secretName: "memory-hub-member",
          memorySpaceId: null,
        }),
      ).toThrow();
  });
  it("replaces memory hub configuration as one dedicated admin field", () => {
    expect(
      decodeHubUpdateInput({
        requestId: "00000000-0000-4000-8000-000000000001",
        expectedVersion: 0,
        action: "configure",
        settings: { mode: "disabled" },
      }),
    ).toMatchObject({ settings: { mode: "disabled" } });
    expect(() =>
      decodeUnknownMemoryHubSettings({
        mode: "disabled",
        endpoint: "https://old.invalid",
      }),
    ).toThrow();
  });
  it("rejects reserved memoryHub in generic settings patch", () => {
    for (const raw of [
      { memoryHub: { mode: "disabled" } },
      { memoryHubVersion: 1 },
      { newWorktreesStartFromOrigin: false, memoryHub: { mode: "disabled" } },
      { newWorktreesStartFromOrigin: false, memoryHubVersion: 1 },
    ])
      expect(() => decodeServerSettingsPatch(raw)).toThrow();
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false, futureField: 1 }),
    ).toEqual({
      newWorktreesStartFromOrigin: false,
    });
  });
});

describe("managed memory settings", () => {
  it("defaults installed agent memory on and owner source reads to an empty policy", () => {
    const settings = decodeServerSettings({});
    expect(settings.enableAgentMemoryAccess).toBe(true);
    expect(settings.memoryOwnerSourceReadPolicy).toEqual({
      allowedRequesterEnvironmentIds: [],
      ownerPolicyEpoch: 0,
      removals: [],
      enrollments: [],
    });
    expect(settings.memoryOwnerSourceReadPolicyVersion).toBe(0);
    expect(decodeServerSettings(encodeServerSettings(settings))).toEqual(settings);
  });
  it("round-trips memory off and guards both on/off updates with settings write", () => {
    expect(decodeServerSettings({ enableAgentMemoryAccess: false }).enableAgentMemoryAccess).toBe(
      false,
    );
    expect(decodeServerSettingsPatch({ enableAgentMemoryAccess: false })).toEqual({
      enableAgentMemoryAccess: false,
    });
    for (const enabled of [true, false])
      expect(requiredScopesForServerSettingsPatch({ enableAgentMemoryAccess: enabled })).toEqual([
        "settings:write",
      ]);
    expect(() => decodeServerSettingsPatch({ enableAgentMemoryAccess: "on" })).toThrow();
    expect(decodeServerSettings({}).memoryEnabled).toBe(true);
    expect(decodeServerSettings({}).memoryModelSelection).toBeNull();
    const selection = { instanceId: "codex", model: "gpt-5.4-mini" };
    expect(
      decodeServerSettingsPatch({ memoryEnabled: false, memoryModelSelection: selection }),
    ).toEqual({
      memoryEnabled: false,
      memoryModelSelection: selection,
    });
    expect(decodeServerSettingsPatch({ memoryModelSelection: null })).toEqual({
      memoryModelSelection: null,
    });
    expect(requiredScopesForServerSettingsPatch({ memoryEnabled: false })).toEqual([
      "settings:write",
    ]);
    for (const key of ["memoryOwnerSourceReadPolicy", "memoryOwnerSourceReadPolicyVersion"])
      expect(() =>
        decodeServerSettingsPatch({ [key]: key.endsWith("Version") ? 0 : {} }),
      ).toThrow();
  });
});

it("keeps process-neutral memory disabled", () => {
  const decoded = decodeServerSettings({});
  expect(decoded.memoryHub).toEqual({ mode: "disabled" });
});
