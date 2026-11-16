import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type IntegrationsState,
  makeProviderSettingsSchema,
  PROVIDER_DISPLAY_NAMES,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { UNKNOWN_SOURCE_CONTROL_CLIENT } from "@t3tools/client-runtime/source-control-clients";
import * as Schema from "effect/Schema";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  integrationSearchItems,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
  searchableSetting,
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  sourceControlHostSearchItems,
  sourceControlHostSettingsSearchId,
  type SettingsSearchAvailability,
  type SettingsSearchItem,
} from "./settingsSearch";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isSecretsFeatureEnabled: false,
}));

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/access",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

const EVERYTHING_AVAILABLE = {
  localEnvironmentDisabled: false,
  hasCloudPublicConfig: true,
  hasEnvironment: true,
  hasProviderSettingsEnvironment: true,
  canManageLocalBackend: true,
  isWslSettingsRowVisible: true,
  hasThreadAutoSettlement: true,
  managedTunnelActive: true,
  hasPeerLinkHost: true,
  hasMemory: true,
  hasIntegrations: true,
  hasImessage: true,
  hasTelegram: true,
  hasMacProviderSettingsEnvironment: true,
  hasComputerUseHostEnvironment: true,
  hasFastWorktreeCheckoutEnvironment: true,
  hasTextGeneratorsEnvironment: true,
  hasPrimaryEnvironment: true,
} satisfies Required<SettingsSearchAvailability>;

describe("searchSettings", () => {
  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("sharing", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    for (const query of ["fallback", "fallback agent", "fallback model"]) {
      expect(searchSettings(query)[0]).toMatchObject({
        id: "fallback-model",
        to: "/settings/threads",
        scope: "environment-defaults",
      });
    }
  });

  it("hides the Secrets page from nav and search while the secrets feature is disabled", () => {
    expect(SETTINGS_NAV_GROUPS.flatMap((group) => group.paths)).not.toContain("/settings/secrets");
    expect(searchSettings("1password").map((item) => item.to)).not.toContain("/settings/secrets");
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toContain("setting-glass-opacity");
    expect(
      searchSettings("liquid glass").find((item) => item.id === "appearance-style"),
    ).toMatchObject({
      title: "Style",
      to: "/settings/appearance",
    });
    expect(
      searchSettings("custom backdrop").find((item) => item.id === "appearance-background"),
    ).toMatchObject({ title: "Background", to: "/settings/appearance" });
    expect(searchSettings("panel animations").map((item) => item.id)).toEqual(["panel-animations"]);
    expect(searchSettings("thè\u{1ab0}mes")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("tells the two machines' limits apart by the machine they belong to", () => {
    const limits = searchSettings("cpu limit").filter((item) => item.title === "CPU limit");
    expect(limits.map((item) => [item.id, item.machine])).toEqual([
      ["heavy-work-cpu-ceiling", "This Mac"],
      ["runner-linux-cpu-ceiling", "Linux PC"],
      ["assistant-sandbox-cpu", undefined],
    ]);
    expect(searchSettings("linux pc cpu").map((item) => item.id)).toContain(
      "runner-linux-cpu-ceiling",
    );
    expect(searchSettings("this mac memory free").map((item) => item.id)).toEqual([
      "heavy-work-memory-floor",
    ]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit").map((item) => item.id)).not.toContain(
      "quit-confirmation",
    );
    expect(searchSettings("wsl").map((item) => item.id)).toEqual([]);
    expect(searchSettings("update track").map((item) => item.id)).toEqual([]);
  });

  it("hides System glass when the desktop bridge has no material API", () => {
    const item: SettingsSearchItem = {
      id: "desktop-system-material",
      title: "System glass",
      to: "/settings/appearance",
      requiresDesktopWindowMaterial: true,
    };
    try {
      vi.stubGlobal("window", { desktopBridge: {} });
      expect(searchSettings("system glass", [item])).toEqual([]);
      vi.stubGlobal("window", {
        desktopBridge: { getWindowMaterialState: vi.fn(), onWindowMaterialStateChanged: vi.fn() },
      });
      expect(searchSettings("system glass", [item]).map((result) => result.id)).toEqual([
        "desktop-system-material",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "source-control-writer-model",
      "review-guide-model",
      "review-guide-instructions",
      "source-control-writing-style",
      "t3-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
      "linked-environments",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("finds linked environments on a remote host without local maintenance access", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      localEnvironmentDisabled: true,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const results = (hasPeerLinkHost: boolean) =>
      searchSettings(
        "linked environments",
        filterAvailableSettingsSearchItems({ ...availability, hasPeerLinkHost }),
      );
    expect(results(false).map((item) => item.id)).not.toContain("linked-environments");
    expect(results(true)).toContainEqual(
      expect.objectContaining({
        id: "linked-environments",
        to: "/settings/connections",
        targetId: "linked-environments",
      }),
    );
  });

  it("finds the Welcome page only where a primary computer can open it", () => {
    const availability = {
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const ids = (hasPrimaryEnvironment: boolean) =>
      searchSettings(
        "welcome page",
        filterAvailableSettingsSearchItems({ ...availability, hasPrimaryEnvironment }),
      ).map((item) => item.id);
    // Hosted web reaches remote computers but has no primary one to set up.
    expect(ids(false)).not.toContain("welcome-page");
    expect(ids(true)).toContain("welcome-page");
  });

  it("offers each computer-use page only where a host of its kind is connected", () => {
    const availability = {
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    for (const [hosts, pages] of [
      [{}, []],
      [{ hasMacProviderSettingsEnvironment: true }, ["mac-permissions"]],
      [{ hasComputerUseHostEnvironment: true }, ["computer-use"]],
      [
        { hasMacProviderSettingsEnvironment: true, hasComputerUseHostEnvironment: true },
        ["mac-permissions", "computer-use"],
      ],
    ] as const) {
      const ids = filterAvailableSettingsSearchItems({ ...availability, ...hosts })
        .map((item) => item.id)
        .filter((id) => id === "mac-permissions" || id === "computer-use");
      expect(ids).toEqual(pages);
    }
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("thread.stop")[0]).toMatchObject({
      id: "keybinding-thread.stop",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("finds rows by the titles shown on their pages", () => {
    for (const title of [
      "Automatic worktree cleanup",
      "Delete settled worktrees",
      "Delete old browser artifacts",
      "Delete old rotated logs",
      "Custom search URL",
      "Native sessions",
      "CODEX_HOME path",
      "Shadow home path",
    ]) {
      expect(searchSettings(title)[0]?.title, title).toBe(title);
    }
  });

  // One row per area whose rows used to draw text the index never saw.
  it.each([
    { query: "runtime", title: "Runtime", to: "/settings/providers" },
    { query: "account", title: "Account", to: "/settings/providers" },
    { query: "budget", title: "Budget (USD)", to: "/settings/providers" },
    { query: "warn at", title: "Warn at (%)", to: "/settings/providers" },
    { query: "turns yellow", title: "Warn at (%)", to: "/settings/providers" },
    { query: "cursor account", title: "Cursor account", to: "/settings/providers" },
    { query: "manage servers", title: "Manage servers", to: "/settings/providers" },
    { query: "fallback models", title: "Fallback models", to: "/settings/threads" },
    { query: "model by folder", title: "Model by folder", to: "/settings/threads" },
    { query: "when a task is done", title: "When a task is done", to: "/settings/assistants" },
    { query: "stuck after", title: "Stuck after", to: "/settings/assistants" },
    { query: "agent memory access", title: "Allow agent memory access", to: "/settings/memory" },
    { query: "reconcile sync", title: "Reconcile sync", to: "/settings/memory" },
    { query: "tool output", title: "Summarize old tool output", to: "/settings/maintenance" },
    { query: "reclaim", title: "Reclaim freed database space", to: "/settings/maintenance" },
    { query: "cleanup instructions", title: "Cleanup instructions", to: "/settings/voice" },
    { query: "pinned projects", title: "Pin", to: "/settings/projects" },
    { query: "board to configure", title: "Board to configure", to: "/settings/kanban" },
    { query: "scheduled tasks", title: "Scheduled tasks", to: "/settings/scheduled-tasks" },
    { query: "first run on the phone", title: "First run on the phone", to: "/settings/devices" },
  ] as const)("finds the $title row by $query", ({ query, title, to }) => {
    const found = searchSettings(query, filterAvailableSettingsSearchItems(EVERYTHING_AVAILABLE));
    expect(found.map((item) => [item.title, item.to])).toContainEqual([title, to]);
  });

  it("shows rows that share a title, page and jump target once", () => {
    const runtimes = searchSettings("runtime").filter((item) => item.title === "Runtime");
    expect(runtimes).toHaveLength(1);
  });

  it("finds every provider by its display name", () => {
    for (const name of Object.values(PROVIDER_DISPLAY_NAMES).filter((name) => name !== undefined)) {
      expect(searchSettings(name).map((item) => item.title)).toContain(name);
    }
  });

  it("finds integrations by the name and blurb the directory draws", () => {
    const items = integrationSearchItems([
      {
        catalog: [],
        integrations: [],
        ownApps: [],
        loopbackRedirectUri: "http://127.0.0.1:1/callback",
        detected: [
          {
            id: "detected-1",
            name: "Acme tracker",
            origin: "claude-code" as const,
            transport: "http",
            catalogId: null,
            enabled: true,
            copyable: false,
            secretKeys: [],
            needsValue: [],
          },
        ],
        detectionSources: [],
      } satisfies IntegrationsState,
    ]);
    expect(searchSettings("acme", items).map((item) => [item.title, item.to])).toEqual([
      ["Acme tracker", "/settings/integrations"],
    ]);
  });

  it("hides every row of a page that this machine does not have", () => {
    const pages = filterAvailableSettingsSearchItems({
      ...EVERYTHING_AVAILABLE,
      hasMemory: false,
      hasTelegram: false,
    }).map((item) => item.to);
    expect(pages).not.toContain("/settings/memory");
    expect(pages).not.toContain("/settings/telegram");
    expect(pages).toContain("/settings/imessage");
  });

  it("keeps each description short enough to stay two lines beside a control", () => {
    const long = SETTINGS_SEARCH_ITEMS.flatMap((item: SettingsSearchItem) =>
      (item.description?.length ?? 0) > 200 ? [item.id] : [],
    );
    expect(long).toEqual([]);
  });

  it("keeps setting ids a closed set", () => {
    // @ts-expect-error A row cannot read text for an id the index does not hold.
    expect(() => searchableSetting("not-a-setting")).toThrow();
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("settings search targets", () => {
  it("requires an environment for the resolved telemetry export destination", () => {
    const result = searchSettings("OpenTelemetry export").find(
      (item) => item.id === "telemetry-export",
    )!;
    const target = getSettingsSearchTargetScope(result.targetId ?? result.id)!;
    expect(isSettingsSearchScopeAvailable(target.scope, "all")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "project")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "environment")).toBe(true);
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    const fallback = getSettingsSearchTargetScope("fallback-model")!;
    expect(fallback.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(fallback.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(fallback.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(fallback.scope, "project")).toBe(false);
    for (const id of ["response-streaming", "speech-project-dictionary"]) {
      expect(getSettingsSearchTargetScope(id)?.scope).toBe("project-defaults");
    }
    for (const scope of ["all", "environment", "project"] as const) {
      expect(isSettingsSearchScopeAvailable("project-defaults", scope)).toBe(true);
    }
    for (const id of ["tool-call-visibility"]) {
      expect(getSettingsSearchTargetScope(id)!.scope).toBeNull();
    }
  });
});

describe("auto-settlement search availability", () => {
  function environment(id: string, { connected = true, loaded = true } = {}) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
      serverConfig: loaded ? { environment: { capabilities: {} } } : null,
    };
  }

  const capable = environment("capable");
  const offline = environment("offline", { connected: false });
  const loading = environment("loading", { loaded: false });
  const environments = [capable, offline, loading];

  it("keeps results discoverable when one connected environment supports them", () => {
    const availability = getThreadAutoSettlementSearchAvailability(environments);
    expect(availability.eligibleEnvironmentIds).toEqual([capable.environmentId]);
    const items = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: availability.eligibleEnvironmentIds.length > 0,
    });
    expect(searchSettings("auto-settle", items).map((item) => item.id)).toEqual([
      "threads-section-auto-settle",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
      "keep-threads-with-pull-requests",
    ]);
  });

  it.each([offline, loading])(
    "does not render the target on $environmentId or silently fall back",
    (selected) => {
      expect(
        getThreadAutoSettlementSearchAvailability(environments, {
          kind: "environment",
          environmentIds: [selected.environmentId],
        }),
      ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
    },
  );

  it("ignores offline and unloaded targets when all connected targets support the setting", () => {
    const selected = [capable, offline, loading];
    expect(
      getThreadAutoSettlementSearchAvailability(selected, {
        kind: "all",
        environmentIds: selected.map((entry) => entry.environmentId),
      }).isTargetAvailable,
    ).toBe(true);
  });
});

describe("source control host search items", () => {
  const definition = {
    ...UNKNOWN_SOURCE_CONTROL_CLIENT,
    kind: SourceControlProviderKind.make("example"),
    label: "Example",
    searchKeywords: ["sample"],
    settings: makeProviderSettingsSchema({ apiToken: Schema.String }),
  };

  it("lists a host by its label, its keywords, and its settings fields", () => {
    const items = sourceControlHostSearchItems([UNKNOWN_SOURCE_CONTROL_CLIENT, definition]);
    expect(items.map((item) => item.title)).toEqual(["Example credentials"]);
    expect(searchSettings("sample apitoken", items).map((item) => item.id)).toEqual([
      sourceControlHostSettingsSearchId("example"),
    ]);
  });

  it("lists a host with credentials by its accounts, token and CLI", () => {
    const items = sourceControlHostSearchItems([
      {
        ...definition,
        credentials: {
          cliName: "ex",
          cliLabel: "Example CLI",
          loginCommand: "ex login",
          tokenEnvVar: "EX_TOKEN",
          tokenAccess: "access",
          newTokenUrl: (host) => `https://${host}/tokens`,
        },
      },
    ]);
    expect(items.map((item) => item.title)).toEqual(["Example accounts and token"]);
    expect(searchSettings("ex switch accounts", items)).toHaveLength(1);
  });

  it("finds the built-in hosts by their own words", () => {
    expect(searchSettings("codeberg").map((item) => item.id)).toContain("source-control");
    expect(searchSettings("ghes").map((item) => item.id)).toContain(
      sourceControlHostSettingsSearchId("github"),
    );
  });
});

describe("movedSettingsPath", () => {
  it("sends old links to the page their row moved to", () => {
    expect(movedSettingsPath("/settings/general", "text-generation-model")).toBe(
      "/settings/threads",
    );
    expect(movedSettingsPath("/settings/connections", "authorized-clients")).toBe(
      "/settings/access",
    );
    expect(movedSettingsPath("/settings/source-control", "worktree-branch-naming")).toBe(
      "/settings/worktrees",
    );
    expect(movedSettingsPath("/settings/appearance", "diff-color-scheme")).toBe("/settings/diffs");
    expect(movedSettingsPath("/settings/connections", "network-access")).toBe("/settings/access");
    expect(movedSettingsPath("/settings/storage", "storage-worktrees")).toBe("/settings/worktrees");
    expect(movedSettingsPath("/settings/storage", "")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/integrations", "devices")).toBe("/settings/devices");
    expect(movedSettingsPath("/settings/beta", "")).toBe("/settings/labs");
  });

  it("leaves current pages alone", () => {
    expect(movedSettingsPath("/settings/general", "time-format")).toBeNull();
    expect(movedSettingsPath("/settings/projects", "project-defaults")).toBeNull();
    expect(movedSettingsPath("/settings/connections", "remote-environments")).toBeNull();
    expect(movedSettingsPath("/settings/appearance", "theme")).toBeNull();
    expect(movedSettingsPath("/settings/integrations", "")).toBeNull();
    expect(movedSettingsPath("/settings/integrations", "integrations")).toBeNull();
  });
});
