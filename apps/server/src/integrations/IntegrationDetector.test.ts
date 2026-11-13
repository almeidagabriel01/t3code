// @effect-diagnostics nodeBuiltinImport:off -- fixture files on a temporary home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { IntegrationCatalogEntry, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import catalogJson from "./catalog.json" with { type: "json" };
import * as IntegrationDetector from "./IntegrationDetector.ts";

const catalog = Schema.decodeUnknownSync(Schema.Array(IntegrationCatalogEntry))(catalogJson);
const withPackage = [
  ...catalog,
  {
    ...catalog.find((entry) => entry.id === "github")!,
    id: "github-local",
    match: { urls: [], packages: ["@modelcontextprotocol/server-github"], names: [] },
  },
];

it.each([
  ["a catalog URL", { url: "https://mcp.linear.app/mcp" }, "linear"],
  [
    "the same URL with case, port, slash and query",
    { url: "HTTPS://MCP.Linear.App:443/mcp/?x=1#f" },
    "linear",
  ],
  [
    "a URL the catalog lists with a trailing slash",
    { url: "https://api.githubcopilot.com/mcp" },
    "github",
  ],
  [
    "an npm package with a version",
    { command: "npx", args: ["-y", "@modelcontextprotocol/server-github@1.2.0"] },
    "github-local",
  ],
  ["a name in another case", { name: "Notion" }, "notion"],
  [
    "a claude.ai connector by its full name",
    { name: "claude.ai Google Calendar" },
    "google-calendar",
  ],
  ["a plugin server by its last segment", { name: "plugin:tools:linear" }, "linear"],
  [
    "the URL wins over a misleading name",
    { name: "notion", url: "https://mcp.linear.app/mcp" },
    "linear",
  ],
  ["an unknown server is Other", { name: "my-tools", url: "https://tools.example.test/mcp" }, null],
  ["a garbage URL falls through to the name", { name: "slack", url: "not a url" }, "slack"],
] as const)("matches %s", (_label, server, expected) => {
  expect(IntegrationDetector.matchCatalog(withPackage, { name: "x", args: [], ...server })).toBe(
    expected,
  );
});

it("parses Claude Code servers tolerantly and flags ${VAR} values", () => {
  expect(
    IntegrationDetector.parseClaudeServers({
      linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { "X-Key": "${KEY}" } },
      local: { command: "node", args: ["srv.js", 3], env: { TOKEN: "t0k", PORT: 1 }, extra: true },
      events: { type: "sse", url: "https://sse.example.test/sse" },
      broken: { type: "http" },
      notAnObject: "x",
    }),
  ).toEqual([
    {
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      command: undefined,
      args: [],
      headers: { "X-Key": "${KEY}" },
      env: {},
      needsValue: ["X-Key"],
      enabled: true,
    },
    {
      name: "local",
      transport: "stdio",
      url: undefined,
      command: "node",
      args: ["srv.js"],
      headers: {},
      env: { TOKEN: "t0k" },
      needsValue: [],
      enabled: true,
    },
    {
      name: "events",
      transport: "sse",
      url: "https://sse.example.test/sse",
      command: undefined,
      args: [],
      headers: {},
      env: {},
      needsValue: [],
      enabled: true,
    },
  ]);
  expect(IntegrationDetector.parseClaudeServers(undefined)).toEqual([]);
});

it("parses Codex servers: env-sourced credentials need a value, disabled stays listed", () => {
  const servers = IntegrationDetector.parseCodexServers(`
model = "x"
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_TOKEN"
env_http_headers = { "X-Org" = "ORG" }
http_headers = { "X-Static" = "s" }

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
env = { API_KEY = "k" }
env_vars = ["HOME_TOKEN"]
enabled = false

[mcp_servers.empty]
startup_timeout_sec = 5
`);
  expect(servers.map((server) => [server.name, server.transport, server.enabled])).toEqual([
    ["linear", "http", true],
    ["docs", "stdio", false],
  ]);
  expect(servers[0]!.needsValue).toEqual(["Authorization", "X-Org"]);
  expect(servers[0]!.headers).toEqual({ "X-Static": "s" });
  expect(servers[1]!.needsValue).toEqual(["HOME_TOKEN"]);
  expect(() => IntegrationDetector.parseCodexServers("[[[ not toml")).toThrow();
});

it.each([
  ["nothing says so", [{}], "pending"],
  ["enabled in the project entry", [{ enabledMcpjsonServers: ["a"] }], "approved"],
  ["enable all in settings", [undefined, { enableAllProjectMcpServers: true }], "approved"],
  [
    "disabled wins over enable all",
    [{ disabledMcpjsonServers: ["a"] }, { enableAllProjectMcpServers: true }],
    "disabled",
  ],
  ["another server's approval", [{ enabledMcpjsonServers: ["b"] }], "pending"],
] as const)(".mcp.json approval: %s", (_label, sources, expected) => {
  expect(IntegrationDetector.mcpJsonApproval("a", sources)).toBe(expected);
});

it.each([
  ["Linear", "linear"],
  ["claude.ai Google Drive", "claude-ai-google-drive"],
  ["--", "server"],
  ["a".repeat(60), "a".repeat(36)],
])("names a copy of %s", (name, expected) => {
  expect(IntegrationDetector.serverNameFrom(name)).toBe(expected);
});

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");
const TOKEN = "sk-live-secret-token";

const writeFixtures = (root: string) => {
  const home = NodePath.join(root, "home");
  const claudeHome = NodePath.join(root, "claude");
  const project = NodePath.join(root, "project");
  const codexHome = NodePath.join(home, ".codex");
  for (const dir of [home, claudeHome, NodePath.join(project, ".claude"), codexHome]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  const files: Record<string, string> = {
    [NodePath.join(claudeHome, ".claude.json")]: JSON.stringify({
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        tools: {
          command: "node",
          args: ["tools.js", `--key=${TOKEN}`],
          env: { API_TOKEN: TOKEN, "BAD KEY": "x", FROM_ENV: "${HOME_TOKEN}" },
        },
        lan: {
          type: "http",
          url: "http://192.168.1.5/mcp",
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
        hooked: {
          type: "http",
          url: `https://hooks.example.test/mcp?token=${TOKEN}`,
          headers: { "X-A": TOKEN },
        },
      },
      projects: {
        [project]: {
          mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/mcp" } },
          enabledMcpjsonServers: ["slack"],
        },
      },
    }),
    [NodePath.join(project, ".mcp.json")]: JSON.stringify({
      mcpServers: {
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
        pending: { command: "npx", args: ["pending-mcp"] },
      },
    }),
    [NodePath.join(project, ".claude", "settings.local.json")]: "{ not json",
    [NodePath.join(codexHome, "config.toml")]: `
[mcp_servers.sentry]
url = "https://mcp.sentry.dev/mcp"
bearer_token_env_var = "SENTRY"
`,
  };
  for (const [file, content] of Object.entries(files)) NodeFS.writeFileSync(file, content);
  return { home, claudeHome, project, files };
};

const setup = (root: string) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const fixtures = writeFixtures(root);
    const values = new Map<string, Uint8Array>();
    const context = yield* Layer.build(
      IntegrationDetector.layer.pipe(
        Layer.provideMerge(
          ServerSettings.layerTest({
            providerInstances: {
              [CLAUDE]: { driver: "claudeAgent", config: { homePath: fixtures.claudeHome } },
            },
            mcpServers: {
              mine: {
                enabled: true,
                transport: "http",
                url: "https://mine.example.test/mcp",
                headers: {},
              },
            },
          }),
        ),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.succeed(
            ServerSecretStore.ServerSecretStore,
            ServerSecretStore.ServerSecretStore.of({
              get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
              set: (name, value) => Effect.sync(() => void values.set(name, value)),
              create: (name, value) => Effect.sync(() => void values.set(name, value)),
              getOrCreateRandom: () => Effect.die("unused"),
              remove: (name) => Effect.sync(() => void values.delete(name)),
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, fixtures.home)),
        Layer.provide(Layer.succeed(HostProcess.Environment, {})),
      ),
    );
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        'p1', 'Fixture', ${fixtures.project}, NULL, '[]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      )
    `;
    return {
      ...fixtures,
      detector: Context.get(context, IntegrationDetector.IntegrationDetector),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
    };
  });

const tempRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-detector-"));

it.effect("detects every source read-only, with origins, scopes and nothing secret", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup(tempRoot());
      yield* env.detector.recordClaudeSession(CLAUDE, [
        { name: "linear", status: "connected" },
        { name: "claude.ai Gmail", status: "needs-auth" },
        { name: "claude.ai Notion", status: "connected" },
        { name: "plugin:kit:sentry", status: "connected" },
        { name: "t3-code", status: "connected" },
        { name: "linear_t3", status: "connected" },
      ]);
      const before = Object.fromEntries(
        Object.keys(env.files).map((file) => [file, NodeFS.readFileSync(file)]),
      );
      const { detected, sources } = yield* env.detector.detect;
      const summary = detected.map((server) => [
        server.origin,
        server.scope ?? null,
        server.name,
        server.catalogId,
        server.loaded ?? null,
        server.approval ?? null,
        server.copyable,
      ]);
      expect(summary).toEqual([
        ["claude-code", "user", "linear", "linear", "connected", null, true],
        ["claude-code", "user", "tools", null, null, null, true],
        ["claude-code", "user", "lan", null, null, null, true],
        ["claude-code", "user", "hooked", null, null, null, true],
        ["claude-ai", null, "claude.ai Gmail", "gmail", "needs-auth", null, false],
        ["claude-ai", null, "claude.ai Notion", "notion", "connected", null, false],
        ["claude-code", "plugin", "plugin:kit:sentry", "sentry", "connected", null, false],
        ["claude-code", "local", "notion", "notion", null, null, true],
        ["claude-code", "project", "slack", "slack", null, "approved", true],
        ["claude-code", "project", "pending", null, null, "pending", true],
        ["codex", null, "sentry", "sentry", null, null, true],
        ["t3", null, "mine", null, null, null, false],
      ]);
      const tools = detected.find((server) => server.name === "tools")!;
      expect(tools.command).toBe("node");
      expect(tools.secretKeys).toEqual(["API_TOKEN", "BAD KEY"]);
      expect(tools.needsValue).toEqual(["FROM_ENV"]);
      expect(detected.find((server) => server.name === "hooked")!.url).toBe(
        "https://hooks.example.test/mcp",
      );
      expect(detected.find((s) => s.origin === "codex")!.needsValue).toEqual(["Authorization"]);
      // No value, argument, query or header content reaches the payload.
      expect(JSON.stringify({ detected, sources })).not.toContain(TOKEN);
      expect(sources.map((source) => [source.origin, source.status])).toEqual([
        ["claude-code", "ok"],
        ["claude-ai", "ok"],
        ["codex", "ok"],
        ["t3", "ok"],
      ]);
      // INT-33: detection never writes a provider file.
      for (const [file, bytes] of Object.entries(before)) {
        expect(NodeFS.readFileSync(file).equals(bytes)).toBe(true);
      }
      expect(yield* env.detector.nativeCatalogIds(CLAUDE)).toEqual(
        new Set(["linear", "notion", "sentry"]),
      );
      expect(yield* env.detector.nativeCatalogIds(CODEX)).toEqual(new Set(["sentry"]));
    }),
  ),
);

it.effect("one unreadable source never hides the others, and claude.ai says not seen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup(tempRoot());
      NodeFS.writeFileSync(NodePath.join(env.claudeHome, ".claude.json"), "{ broken");
      NodeFS.writeFileSync(NodePath.join(env.project, ".mcp.json"), "[]");
      NodeFS.writeFileSync(NodePath.join(env.home, ".codex", "config.toml"), "[[[");
      const { detected, sources } = yield* env.detector.detect;
      expect(sources).toEqual([
        expect.objectContaining({
          origin: "claude-code",
          status: "unreadable",
          reason: "invalid-format",
        }),
        { origin: "claude-ai", instanceId: CLAUDE, status: "not-seen" },
        expect.objectContaining({
          origin: "claude-code",
          path: NodePath.join(env.project, ".mcp.json"),
          status: "unreadable",
          reason: "invalid-format",
        }),
        expect.objectContaining({
          origin: "codex",
          status: "unreadable",
          reason: "invalid-format",
        }),
        { origin: "t3", status: "ok" },
      ]);
      expect(detected.map((server) => server.name)).toEqual(["mine"]);
      NodeFS.rmSync(NodePath.join(env.home, ".codex", "config.toml"));
      expect((yield* env.detector.detect).sources.find((s) => s.origin === "codex")?.status).toBe(
        "missing",
      );
      expect(yield* env.detector.nativeCatalogIds(CLAUDE)).toEqual(new Set());
    }),
  ),
);

it.effect("an unchanged file is not parsed again, and a touched one is", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup(tempRoot());
      const file = NodePath.join(env.home, ".codex", "config.toml");
      const codexNames = Effect.map(env.detector.detect, ({ detected }) =>
        detected.filter((server) => server.origin === "codex").map((server) => server.name),
      );
      // Whole seconds: utimes takes float seconds, which can round a millisecond away.
      const mtime = new Date(1_700_000_000_000);
      NodeFS.utimesSync(file, mtime, mtime);
      expect(yield* codexNames).toEqual(["sentry"]);
      // Same size and mtime: only a memo keyed on them can still answer "sentry".
      NodeFS.writeFileSync(file, env.files[file]!.replace("sentry]", "sentrz]"));
      NodeFS.utimesSync(file, mtime, mtime);
      expect(yield* codexNames).toEqual(["sentry"]);
      NodeFS.utimesSync(file, mtime, new Date(1_700_000_005_000));
      expect(yield* codexNames).toEqual(["sentrz"]);
    }),
  ),
);

it.effect("make available copies on consent, once, and refuses what it cannot carry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup(tempRoot());
      yield* env.detector.recordClaudeSession(CLAUDE, [
        { name: "claude.ai Gmail", status: "connected" },
      ]);
      const before = Object.fromEntries(
        Object.keys(env.files).map((file) => [file, NodeFS.readFileSync(file)]),
      );
      const { detected } = yield* env.detector.detect;
      const idOf = (name: string, scope?: string) =>
        detected.find(
          (server) => server.name === name && (scope === undefined || server.scope === scope),
        )!.id;
      const reason = (detectedId: string) =>
        env.detector.makeAvailable({ detectedId }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      const copied = yield* env.detector.makeAvailable({ detectedId: idOf("tools") });
      expect(copied).toEqual({
        outcome: "copied",
        name: "tools",
        leftOut: ["FROM_ENV", "BAD KEY"],
      });
      const stored = (yield* env.settings.getSettings).mcpServers.tools;
      expect(stored).toEqual({
        enabled: true,
        transport: "stdio",
        command: "node",
        args: ["tools.js", `--key=${TOKEN}`],
        env: { API_TOKEN: TOKEN },
      });
      // A repeat lands on the same copy.
      expect(yield* env.detector.makeAvailable({ detectedId: idOf("tools") })).toEqual(copied);
      expect(Object.keys((yield* env.settings.getSettings).mcpServers)).toEqual(["mine", "tools"]);

      // A static header is a credential to copy; a name taken by another server gets a suffix.
      yield* env.settings.updateSettings({
        mcpServers: {
          slack: { enabled: true, transport: "stdio", command: "x", args: [], env: {} },
        },
      });
      expect(yield* env.detector.makeAvailable({ detectedId: idOf("slack") })).toEqual({
        outcome: "copied",
        name: "slack-2",
        leftOut: [],
      });
      // OAuth held by Claude Code: Connect the catalog entry in T3 instead (INT-37).
      expect(yield* env.detector.makeAvailable({ detectedId: idOf("linear") })).toEqual({
        outcome: "connect",
        catalogId: "linear",
      });
      expect(yield* env.detector.makeAvailable({ detectedId: idOf("notion", "local") })).toEqual({
        outcome: "connect",
        catalogId: "notion",
      });
      expect(yield* reason(idOf("lan"))).toBe("url-not-allowed");
      expect(yield* reason(idOf("hooked"))).toBe("url-not-allowed");
      expect(yield* reason(idOf("claude.ai Gmail"))).toBe("not-copyable");
      expect(yield* reason(idOf("mine"))).toBe("not-copyable");
      expect(yield* reason("stale")).toBe("detected-not-found");
      // A changed source invalidates the id the consent dialog showed.
      const sentry = idOf("sentry");
      NodeFS.writeFileSync(
        NodePath.join(env.home, ".codex", "config.toml"),
        '[mcp_servers.sentry]\nurl = "https://mcp.sentry.dev/mcp"\n',
      );
      expect(yield* reason(sentry)).toBe("detected-not-found");
      NodeFS.writeFileSync(
        NodePath.join(env.home, ".codex", "config.toml"),
        before[NodePath.join(env.home, ".codex", "config.toml")]!,
      );
      // INT-33: copying never touches the provider files.
      for (const [file, bytes] of Object.entries(before)) {
        expect(NodeFS.readFileSync(file).equals(bytes)).toBe(true);
      }
    }),
  ),
);

it.effect("a session report replaces the instance's list and survives a new detector", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup(tempRoot());
      yield* env.detector.recordClaudeSession(CLAUDE, [
        { name: "claude.ai Slack", status: "connected" },
      ]);
      yield* env.detector.recordClaudeSession(CLAUDE, [
        { name: "claude.ai Asana", status: "connected" },
      ]);
      const names = (yield* env.detector.detect).detected
        .filter((server) => server.origin === "claude-ai")
        .map((server) => server.catalogId);
      expect(names).toEqual(["asana"]);
    }),
  ),
);
