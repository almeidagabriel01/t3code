import type {
  AssistantIntegrations,
  DetectedServer,
  DetectionSource,
  IntegrationCatalogEntry,
  IntegrationsState,
  IntegrationView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantIntegrationPicker,
  detectedOriginLabel,
  integrationAssistantsUsing,
  integrationCategoryLabel,
  integrationDirectory,
  integrationErrorMessage,
  integrationProviderSupport,
  integrationStatusLabel,
  notAvailableOnLabel,
  parsePastedCallback,
  selectionForMode,
  toggleIntegration,
  worksInLabel,
} from "./integrations.ts";

const entry = (
  id: string,
  name: string,
  extra: Partial<IntegrationCatalogEntry> = {},
): IntegrationCatalogEntry =>
  ({
    id,
    name,
    category: "dev",
    description: `${name} tools`,
    docsUrl: "https://example.com",
    server: { transport: "http", url: `https://${id}.example.com/mcp` },
    auth: { kind: "oauth", registration: "dynamic" },
    match: { urls: [], packages: [], names: [] },
    ...extra,
  }) as IntegrationCatalogEntry;

const view = (
  name: string,
  catalogId: string | null,
  status: IntegrationView["status"],
  extra: Partial<IntegrationView> = {},
): IntegrationView =>
  ({
    name,
    catalogId,
    auth: "oauth",
    status,
    availability: "assistants",
    ...extra,
  }) as IntegrationView;

const detected = (
  id: string,
  origin: DetectedServer["origin"],
  catalogId: string | null,
  extra: Partial<DetectedServer> = {},
): DetectedServer =>
  ({
    id,
    name: id,
    origin,
    catalogId,
    transport: "http",
    enabled: true,
    copyable: false,
    secretKeys: [],
    needsValue: [],
    ...extra,
  }) as DetectedServer;

const state = (partial: Partial<IntegrationsState>): IntegrationsState => ({
  catalog: [],
  integrations: [],
  ownApps: [],
  loopbackRedirectUri: "http://127.0.0.1:43110/integrations/callback",
  detected: [],
  detectionSources: [],
  ...partial,
});

describe("integrationStatusLabel", () => {
  it.each([
    ["connected", "Connected", "success"],
    ["needs-sign-in", "Needs sign-in", "warning"],
    ["needs-more-access", "Needs more access", "warning"],
    ["error", "Error", "danger"],
    ["not-connected", "Not connected", "muted"],
    ["connecting", "Waiting for sign-in…", "progress"],
    ["a-future-status", "Error", "danger"],
  ])("%s", (status, label, tone) => {
    expect(integrationStatusLabel(status)).toEqual({ label, tone });
  });
});

describe("integrationErrorMessage", () => {
  it.each([
    ["pkce-unsupported", "This service doesn't support secure sign-in (PKCE)"],
    ["unsupported-auth", "This service doesn't support secure sign-in (PKCE)"],
    ["sign-in-expired", "Sign-in expired or didn't match. Try again"],
    ["invalid-callback", "Sign-in expired or didn't match. Try again"],
    ["unsafe-address", "Unsafe sign-in address"],
    ["unreachable", "Linear didn't respond"],
    ["own-app-required", "Linear needs your own app first"],
    ["discovery-failed", "Couldn't find Linear's sign-in page"],
    [
      "registration-unavailable",
      "Linear doesn't let T3 sign in on its own. Use your own app or a token",
    ],
    ["registration-failed", "Linear refused T3's sign-in"],
    ["sign-in-denied", "Sign-in was cancelled"],
    ["exchange-failed", "Sign-in didn't finish. Try again"],
    ["refresh-failed", "Sign-in didn't finish. Try again"],
    ["invalid-token", "Linear didn't accept this token"],
    ["storage-failed", "Couldn't save on the server"],
    ["unknown-entry", "This integration is no longer in the catalog"],
    ["detected-not-found", "This server changed since the list loaded. Check it and try again"],
    ["not-copyable", "This server can't be copied"],
    ["url-not-allowed", "T3 only copies https addresses without ? or #"],
    ["needs-sign-in", "Needs sign-in"],
    ["not-connected", "Not connected"],
    ["a-future-reason", "Error"],
  ])("%s", (reason, message) => {
    expect(integrationErrorMessage(reason, "Linear")).toBe(message);
  });
});

describe("origin labels", () => {
  it.each([
    [detected("a", "claude-code", null), "Connected in Claude Code", "Works in Claude assistants"],
    [detected("a", "codex", null), "Connected in Codex", "Works in Codex assistants"],
    [detected("a", "claude-ai", null), "Connected in claude.ai", "Works in Claude assistants"],
    [
      detected("a", "claude-ai", null, { loaded: "needs-auth" }),
      "In claude.ai, not signed in",
      "Works in Claude assistants",
    ],
    [detected("a", "t3", null), "Added in T3", null],
  ])("%o", (server, origin, worksIn) => {
    expect(detectedOriginLabel(server)).toBe(origin);
    expect(worksInLabel(server.origin)).toBe(worksIn);
  });
});

describe("integrationCategoryLabel", () => {
  it.each([
    [null, "All"],
    ["calendar", "Calendar"],
    ["email", "Email"],
    ["chat", "Chat"],
    ["docs", "Docs"],
    ["tasks", "Tasks"],
    ["files", "Files"],
    ["dev", "Dev"],
    ["design", "Design"],
    ["crm", "CRM"],
    ["payments", "Payments"],
    ["automation", "Automation"],
  ] as const)("%s", (category, label) => {
    expect(integrationCategoryLabel(category)).toBe(label);
  });
});

describe("integrationDirectory", () => {
  const linear = entry("linear", "Linear", { category: "tasks" });
  const notion = entry("notion", "Notion", { category: "docs" });
  const github = entry("github", "GitHub", {
    tokenFallback: { header: "Authorization", format: "Bearer {token}" },
  });
  const sentry = entry("sentry", "Sentry", { availability: "unavailable", note: "Coming soon" });
  const stripe = entry("stripe", "Stripe", {
    category: "payments",
    auth: { kind: "token", header: "Authorization", format: "Bearer {token}" },
  } as Partial<IntegrationCatalogEntry>);
  const figma = entry("figma", "Figma", { category: "design" });

  const sections = (input: IntegrationsState, query = "", category: string | null = null) => {
    const result = integrationDirectory(input, {
      query,
      category: category as Parameters<typeof integrationDirectory>[1]["category"],
    });
    const keys = (rows: ReadonlyArray<{ readonly key: string }>) => rows.map((row) => row.key);
    return {
      connected: keys(result.connected),
      available: keys(result.available),
      other: keys(result.other),
    };
  };

  it("places each catalog entry by its T3 status or a native copy, and lists the rest", () => {
    const input = state({
      catalog: [notion, linear, github, sentry, stripe, figma],
      integrations: [
        view("linear", "linear", "connected"),
        view("stripe", "stripe", "not-connected"),
        view("old-tool", "gone", "error", { lastError: "unknown-entry" }),
        view("idle", null, "not-connected"),
        view("linear-2", "linear", "needs-sign-in"),
      ],
      detected: [
        detected("cc-figma", "claude-code", "figma"),
        detected("off-notion", "codex", "notion", { enabled: false }),
        detected("hand", "t3", null),
        detected("hand-sentry", "t3", "sentry"),
        detected("Zed", "codex", null),
        detected("cc-gone", "claude-code", "gone"),
      ],
    });
    expect(sections(input)).toEqual({
      connected: [
        "catalog:figma",
        "catalog:linear",
        "integration:linear-2",
        "integration:old-tool",
      ],
      available: [
        "catalog:github",
        "integration:idle",
        "catalog:notion",
        "catalog:sentry",
        "catalog:stripe",
      ],
      other: ["detected:cc-gone", "detected:hand", "detected:hand-sentry", "detected:Zed"],
    });
    expect(sections(input, "", "tasks")).toEqual({
      connected: ["catalog:linear"],
      available: [],
      other: [],
    });
    expect(sections(input, "  GIT ")).toEqual({
      connected: [],
      available: ["catalog:github"],
      other: [],
    });
    expect(sections(input, "zed")).toEqual({
      connected: [],
      available: [],
      other: ["detected:Zed"],
    });
    expect(sections(input, "notion tools")).toEqual({
      connected: [],
      available: ["catalog:notion"],
      other: [],
    });
    expect(sections(input, "cc-figma")).toEqual({
      connected: ["catalog:figma"],
      available: [],
      other: [],
    });
  });

  it("joins the integration named after the entry, else the first", () => {
    const input = state({
      catalog: [linear],
      integrations: [view("linear-work", "linear", "connected"), view("linear", "linear", "error")],
    });
    const result = integrationDirectory(input, { query: "", category: null });
    expect(result.connected.map((row) => [row.key, row.integration?.name])).toEqual([
      ["catalog:linear", "linear"],
      ["integration:linear-work", "linear-work"],
    ]);
  });

  type Row = ReturnType<typeof integrationDirectory>["connected"][number];
  const rowFor = (input: IntegrationsState): Row => {
    const result = integrationDirectory(input, { query: "", category: null });
    const row = [...result.connected, ...result.available, ...result.other][0];
    if (row === undefined) throw new Error("no row");
    return row;
  };
  const pick = (row: Row) => ({
    status: row.status?.label ?? null,
    origins: row.origins.map((origin) => origin.label),
    note: row.note,
    primary: row.primary,
    menu: row.menu.map((action) => action.label),
  });

  it.each([
    {
      case: "available",
      input: state({ catalog: [linear] }),
      expected: {
        status: null,
        origins: [],
        note: null,
        primary: {
          kind: "connect",
          label: "Connect",
          catalogId: "linear",
          disabled: false,
          reason: null,
        },
        menu: [],
      },
    },
    {
      case: "unavailable in the catalog",
      input: state({ catalog: [sentry] }),
      expected: {
        status: null,
        origins: [],
        note: null,
        primary: {
          kind: "connect",
          label: "Connect",
          catalogId: "sentry",
          disabled: true,
          reason: "Coming soon",
        },
        menu: [],
      },
    },
    {
      case: "token fallback while not connected",
      input: state({
        catalog: [github],
        integrations: [view("github", "github", "not-connected")],
      }),
      expected: {
        status: "Not connected",
        origins: [],
        note: null,
        primary: {
          kind: "connect",
          label: "Connect",
          catalogId: "github",
          disabled: false,
          reason: null,
        },
        menu: ["Disconnect", "Use a token instead"],
      },
    },
    {
      case: "token auth",
      input: state({ catalog: [stripe] }),
      expected: {
        status: null,
        origins: [],
        note: null,
        primary: {
          kind: "connect",
          label: "Connect",
          catalogId: "stripe",
          disabled: false,
          reason: null,
        },
        menu: ["Use a token instead"],
      },
    },
    {
      case: "connecting",
      input: state({ catalog: [github], integrations: [view("github", "github", "connecting")] }),
      expected: {
        status: "Waiting for sign-in…",
        origins: [],
        note: null,
        primary: { kind: "cancel", label: "Cancel", name: "github" },
        menu: ["Use a token instead"],
      },
    },
    {
      case: "connected",
      input: state({ catalog: [github], integrations: [view("github", "github", "connected")] }),
      expected: {
        status: "Connected",
        origins: [],
        note: null,
        primary: { kind: "open", name: "github" },
        menu: ["Disconnect"],
      },
    },
    {
      case: "needs sign-in",
      input: state({
        catalog: [linear],
        integrations: [view("linear", "linear", "needs-sign-in", { lastError: "refresh-failed" })],
      }),
      expected: {
        status: "Needs sign-in",
        origins: [],
        note: "Sign-in didn't finish. Try again",
        primary: { kind: "reconnect", label: "Reconnect", catalogId: "linear" },
        menu: ["Disconnect"],
      },
    },
    {
      case: "needs more access without a reason",
      input: state({
        catalog: [linear],
        integrations: [view("linear", "linear", "needs-more-access")],
      }),
      expected: {
        status: "Needs more access",
        origins: [],
        note: null,
        primary: { kind: "reconnect", label: "Reconnect", catalogId: "linear" },
        menu: ["Disconnect"],
      },
    },
    {
      case: "unreachable",
      input: state({
        catalog: [linear],
        integrations: [view("linear", "linear", "error", { lastError: "unreachable" })],
      }),
      expected: {
        status: "Error",
        origins: [],
        note: "Linear didn't respond",
        primary: { kind: "reconnect", label: "Retry", catalogId: "linear" },
        menu: ["Disconnect"],
      },
    },
    {
      case: "an integration whose entry left the catalog",
      input: state({
        integrations: [view("old", "gone", "error", { lastError: "unknown-entry" })],
      }),
      expected: {
        status: "Error",
        origins: [],
        note: "This integration is no longer in the catalog",
        primary: null,
        menu: ["Disconnect"],
      },
    },
    {
      case: "native in Claude Code and Codex",
      input: state({
        catalog: [linear],
        detected: [
          detected("cc", "claude-code", "linear", { copyable: true }),
          detected("cx", "codex", "linear"),
        ],
      }),
      expected: {
        status: null,
        origins: ["Connected in Claude Code", "Connected in Codex"],
        note: "Works in Claude assistants · Works in Codex assistants",
        primary: {
          kind: "connect",
          label: "Connect for other providers",
          catalogId: "linear",
          disabled: false,
          reason: null,
        },
        menu: ["Make available to all providers"],
      },
    },
    {
      case: "native only in claude.ai",
      input: state({
        catalog: [linear],
        detected: [detected("ai", "claude-ai", "linear", { loaded: "needs-auth" })],
      }),
      expected: {
        status: null,
        origins: ["In claude.ai, not signed in"],
        note: "Works in Claude assistants",
        primary: {
          kind: "connect",
          label: "Connect in T3",
          catalogId: "linear",
          disabled: false,
          reason: null,
        },
        menu: [],
      },
    },
    {
      case: "connected in T3 and natively",
      input: state({
        catalog: [linear],
        integrations: [view("linear", "linear", "connected")],
        detected: [detected("cx", "codex", "linear")],
      }),
      expected: {
        status: "Connected",
        origins: ["Connected in Codex"],
        note: null,
        primary: { kind: "open", name: "linear" },
        menu: ["Disconnect"],
      },
    },
    {
      case: "a hand-made server",
      input: state({ detected: [detected("docs", "t3", null, { copyable: false })] }),
      expected: { status: null, origins: ["Added in T3"], note: null, primary: null, menu: [] },
    },
    {
      case: "a copyable Claude Code server",
      input: state({ detected: [detected("zed", "claude-code", null, { copyable: true })] }),
      expected: {
        status: null,
        origins: ["Connected in Claude Code"],
        note: "Works in Claude assistants",
        primary: null,
        menu: ["Make available to all providers"],
      },
    },
  ])("$case", ({ input, expected }) => {
    expect(pick(rowFor(input))).toEqual(expected);
  });

  it("carries the detected id on origins and copy actions", () => {
    const row = rowFor(
      state({
        catalog: [linear],
        detected: [detected("cc", "claude-code", "linear", { copyable: true })],
      }),
    );
    expect(row.origins).toEqual([
      { origin: "claude-code", label: "Connected in Claude Code", detectedId: "cc" },
    ]);
    expect(row.menu).toEqual([
      { kind: "make-available", label: "Make available to all providers", detectedId: "cc" },
    ]);
  });

  it("explains each source it could not read, without hiding the rest", () => {
    const sources: ReadonlyArray<DetectionSource> = [
      { origin: "claude-code", path: "/a.json", status: "unreadable", reason: "permission-denied" },
      { origin: "codex", path: "/b.toml", status: "unreadable", reason: "invalid-format" },
      { origin: "codex", path: "/c.toml", status: "unreadable", reason: "read-failed" },
      { origin: "codex", status: "unreadable" },
      { origin: "claude-ai", instanceId: "claude-main" as never, status: "not-seen" },
      { origin: "claude-code", path: "/ok.json", status: "ok" },
      { origin: "codex", path: "/none.toml", status: "missing" },
    ];
    const result = integrationDirectory(state({ detectionSources: sources }), {
      query: "",
      category: null,
    });
    expect(result.sourceNotes.map(({ label, path, reason }) => ({ label, path, reason }))).toEqual([
      { label: "Couldn't read", path: "/a.json", reason: "Permission denied" },
      { label: "Couldn't read", path: "/b.toml", reason: "Not valid JSON or TOML" },
      { label: "Couldn't read", path: "/c.toml", reason: "Read failed" },
      { label: "Couldn't read", path: null, reason: "Read failed" },
      { label: "Not seen yet (open a Claude conversation)", path: null, reason: null },
    ]);
    expect(result.sourceNotes.map((note) => [note.origin, note.instanceId])).toEqual([
      ["claude-code", null],
      ["codex", null],
      ["codex", null],
      ["codex", null],
      ["claude-ai", "claude-main"],
    ]);
  });
});

describe("integrationProviderSupport", () => {
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
  ])("%s", (driverKind, supported) => {
    expect(integrationProviderSupport(driverKind)).toBe(supported);
  });

  it("names the provider it is missing on", () => {
    expect(notAvailableOnLabel("OpenCode")).toBe("Not available on OpenCode");
  });
});

describe("assistant integration picker", () => {
  const linear = entry("linear", "Linear");
  const notion = entry("notion", "Notion");
  const figma = entry("figma", "Figma");
  const input = state({
    catalog: [linear, notion, figma],
    integrations: [
      view("linear", "linear", "connected"),
      view("notion", "notion", "needs-sign-in"),
      view("figma", "figma", "connected"),
      view("half", null, "connecting"),
    ],
    detected: [
      detected("docs", "t3", null),
      detected("off", "t3", null, { enabled: false }),
      detected("cc-figma", "claude-code", "figma", {
        instanceId: "claude-main" as never,
        scope: "user",
        loaded: "connected",
      }),
      detected("ai-notion", "claude-ai", "notion", {
        instanceId: "claude-main" as never,
        loaded: "connected",
      }),
      detected("cx-linear", "codex", "linear", { instanceId: "codex-main" as never }),
      detected("cc-other", "claude-code", "linear", {
        instanceId: "claude-work" as never,
        scope: "user",
        loaded: "connected",
      }),
    ],
  });
  type Item = ReturnType<typeof assistantIntegrationPicker>["items"][number];
  const brief = (item: Item) => [
    item.title,
    item.status?.label ?? null,
    item.selected,
    item.disabled,
    item.note,
  ];

  it("lists T3 servers, kept names and the provider's native copies", () => {
    const picker = assistantIntegrationPicker({
      state: input,
      selection: { mode: "selected", names: ["linear", "removed"] },
      driverKind: "claudeAgent",
      instanceId: "claude-main",
    });
    expect(picker.mode).toBe("selected");
    expect(picker.items.map(brief)).toEqual([
      ["docs", null, false, false, "Added in T3"],
      ["Figma", "Connected", true, true, "Always on for Claude (set up in Claude Code)"],
      ["half", "Waiting for sign-in…", false, false, null],
      ["Linear", "Connected", true, false, null],
      ["Notion", "Needs sign-in", true, true, "Always on for Claude (set up in Claude Code)"],
      ["off", null, false, false, "Added in T3"],
      ["removed", "Not connected", true, false, null],
    ]);
  });

  it("marks Codex's own copies for a Codex assistant and selects everything in all mode", () => {
    const picker = assistantIntegrationPicker({
      state: state({
        catalog: [linear, notion],
        integrations: [view("notion", "notion", "connected")],
        detected: [detected("cx-linear", "codex", "linear", { instanceId: "codex-main" as never })],
      }),
      selection: { mode: "all" },
      driverKind: "codex",
      instanceId: "codex-main",
    });
    expect(picker.items.map(brief)).toEqual([
      ["Linear", null, true, true, "Always on for Codex (set up in Codex)"],
      ["Notion", "Connected", true, false, null],
    ]);
  });

  it("keeps a selected name that only a native copy shares", () => {
    const picker = assistantIntegrationPicker({
      state: state({
        catalog: [linear],
        detected: [detected("linear", "codex", "linear", { instanceId: "codex-main" as never })],
      }),
      selection: { mode: "selected", names: ["linear"] },
      driverKind: "codex",
      instanceId: "codex-main",
    });
    expect(picker.items.map((item) => [item.key, item.status?.label ?? null])).toEqual([
      ["missing:linear", "Not connected"],
      ["native:linear", null],
    ]);
  });

  it("disables every item on a provider that cannot take integrations", () => {
    const picker = assistantIntegrationPicker({
      state: state({ integrations: [view("linear", "linear", "connected")] }),
      selection: { mode: "all" },
      driverKind: "opencode",
      instanceId: "opencode",
    });
    expect(picker.items.map((item) => item.disabled)).toEqual([true]);
  });

  it.each<[string, AssistantIntegrations, string, AssistantIntegrations]>([
    [
      "adds a name",
      { mode: "selected", names: ["a"] },
      "b",
      { mode: "selected", names: ["a", "b"] },
    ],
    [
      "removes a name",
      { mode: "selected", names: ["a", "b"] },
      "a",
      { mode: "selected", names: ["b"] },
    ],
    ["leaves all mode alone", { mode: "all" }, "a", { mode: "all" }],
  ])("toggle %s", (_case, selection, name, expected) => {
    expect(toggleIntegration(selection, name)).toEqual(expected);
  });

  it.each<[string, "all" | "selected", AssistantIntegrations, AssistantIntegrations]>([
    ["all", "all", { mode: "selected", names: ["linear"] }, { mode: "all" }],
    [
      "selected from all starts with every working server",
      "selected",
      { mode: "all" },
      { mode: "selected", names: ["linear", "notion", "figma", "docs"] },
    ],
    [
      "selected keeps a selection",
      "selected",
      { mode: "selected", names: ["x"] },
      { mode: "selected", names: ["x"] },
    ],
  ])("mode %s", (_case, mode, current, expected) => {
    expect(selectionForMode(mode, current, input)).toEqual(expected);
  });
});

describe("parsePastedCallback", () => {
  it.each([
    [
      "  http://127.0.0.1:4000/integrations/callback?code=a&state=b \n",
      "http://127.0.0.1:4000/integrations/callback?code=a&state=b",
    ],
    [
      "t3code://integrations/callback?error=access_denied",
      "t3code://integrations/callback?error=access_denied",
    ],
    ["http://127.0.0.1:4000/integrations/callback?state=b", null],
    ["/integrations/callback?code=a", null],
    ["not a url", null],
    ["", null],
  ])("%j", (text, expected) => {
    expect(parsePastedCallback(text)).toBe(expected);
  });
});

describe("integrationAssistantsUsing", () => {
  it("counts assistants that select it by name or take all", () => {
    const assistants = [
      { id: "a", integrations: { mode: "all" } },
      { id: "b", integrations: { mode: "selected", names: ["linear"] } },
      { id: "c", integrations: { mode: "selected", names: ["notion"] } },
    ] as const;
    expect(integrationAssistantsUsing("linear", assistants).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
