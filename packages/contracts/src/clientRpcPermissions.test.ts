import { describe, expect, it } from "vite-plus/test";
import {
  clientRpcRequiredScopes,
  CLIENT_GUARDED_RPC_SCOPES,
  RPC_REQUIRED_SCOPES,
  rpcRequiredScopes,
} from "./clientRpcPermissions.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { WS_METHODS } from "./rpc.ts";

describe("memory client guards", () => {
  it("guards all three memory mutations", () => {
    for (const method of [
      WS_METHODS.memoryUpsert,
      WS_METHODS.memoryForget,
      WS_METHODS.memoryRevertResolution,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
  });
  it("requires memory write and filesystem read for provider import", () =>
    expect(clientRpcRequiredScopes(WS_METHODS.memoryImportProvider, {})).toEqual([
      "memory:write",
      "filesystem:read",
    ]));
  it("guards hub settings and owner policy with settings write", () => {
    for (const method of [
      WS_METHODS.memoryHubSettingsGet,
      WS_METHODS.memoryHubSettingsUpdate,
      WS_METHODS.memoryHubReconcile,
      WS_METHODS.memoryOwnerSourceReadPolicyGet,
      WS_METHODS.memoryOwnerSourceReadPolicyUpdate,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
  });
  it("requires explicit transcript permission for readSource and guards bindings", () => {
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.memoryReadSource)).toBe(true);
    expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).toEqual([
      "memory:read",
      "orchestration:read",
    ]);
    for (const method of [
      WS_METHODS.memoryProjectBindingGet,
      WS_METHODS.memoryProjectBindingUpdate,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
  });
  it("memory write never implies source read", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.memoryUpsert, {})).not.toContain(
      "orchestration:read",
    );
    expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).not.toContain("memory:write");
  });
  it("registers every core read guard", () => {
    for (const method of [
      WS_METHODS.memorySearch,
      WS_METHODS.memoryList,
      WS_METHODS.memoryRead,
      WS_METHODS.memoryHistory,
      WS_METHODS.memoryChanges,
      WS_METHODS.memorySyncStatus,
      WS_METHODS.memoryHubDiagnostics,
    ]) {
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe("memory:read");
      expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:read"]);
    }
  });
});

describe("decision client guards", () => {
  it("guards answering, dismissing and reopening, and leaves reads open to readers", () => {
    for (const method of [
      WS_METHODS.decisionsAnswer,
      WS_METHODS.decisionsDismiss,
      WS_METHODS.decisionsReopen,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    for (const method of [WS_METHODS.decisionsList, WS_METHODS.decisionsSubscribe])
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)).toBe(false);
  });
});

describe("kanban problem client guards", () => {
  it("guards ignoring and un-ignoring a problem like other card writes", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.kanbanCardSetProblemIgnored, {})).toEqual([
      "orchestration:operate",
    ]);
  });
});

describe("device client guards", () => {
  it("guards takeover and phone input as driving a device, and access policies and Wi-Fi pairing as settings", () => {
    for (const method of [WS_METHODS.deviceSetHold, WS_METHODS.deviceInput])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    expect(clientRpcRequiredScopes(WS_METHODS.deviceSetAccess, {})).toEqual(["settings:write"]);
    for (const method of [
      WS_METHODS.deviceWifiPairStart,
      WS_METHODS.deviceWifiPairCancel,
      WS_METHODS.deviceForget,
      WS_METHODS.deviceAnswerLinkRequest,
      WS_METHODS.deviceSetLinkBlocked,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
    // Watching device state stays open to readers.
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.subscribeDeviceState)).toBe(false);
  });
});

describe("computer use client guards", () => {
  it("guards opening a System Settings pane and leaves the status read open to readers", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.computerUseOpenSettings, {})).toEqual([
      "settings:write",
    ]);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.computerUsePermissions)).toBe(false);
  });
});

describe("assistant client guards", () => {
  it("guards every assistant mutation and leaves the subscription open to readers", () => {
    for (const method of [
      WS_METHODS.assistantsCreate,
      WS_METHODS.assistantsUpdate,
      WS_METHODS.assistantsDelete,
      WS_METHODS.assistantsReset,
      WS_METHODS.assistantsSetAvatarImage,
      WS_METHODS.assistantsSetTaskDismissed,
      WS_METHODS.assistantTeamsCreate,
      WS_METHODS.assistantTeamsUpdate,
      WS_METHODS.assistantTeamsDelete,
      WS_METHODS.assistantGroupsPost,
      WS_METHODS.assistantGroupsTaskAction,
      WS_METHODS.assistantGroupsMarkRead,
      WS_METHODS.assistantGroupsConversation,
      WS_METHODS.assistantSandboxStart,
      WS_METHODS.assistantSandboxStop,
      WS_METHODS.assistantSandboxRemove,
      WS_METHODS.assistantSandboxConfigure,
      WS_METHODS.assistantSandboxPairing,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    // Reading one project tab is still a mutation of the group's read state.
    expect(
      clientRpcRequiredScopes(WS_METHODS.assistantGroupsMarkRead, {
        teamId: "team:1",
        scope: { projectId: "p1" },
      }),
    ).toEqual(["orchestration:operate"]);
    for (const method of [
      WS_METHODS.assistantsSubscribe,
      WS_METHODS.assistantsSpend,
      WS_METHODS.assistantsLibrary,
      WS_METHODS.assistantGroupsSubscribe,
      WS_METHODS.assistantGroupsHistory,
      WS_METHODS.assistantSandboxSubscribe,
    ])
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)).toBe(false);
  });
});

describe("thread context usage", () => {
  it("is a plain thread read", () => {
    expect(
      rpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.getThreadContextUsage, {
        threadId: "thread:1",
      }),
    ).toEqual(["orchestration:read"]);
    expect(
      Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, ORCHESTRATION_V2_WS_METHODS.getThreadContextUsage),
    ).toBe(false);
  });
});

describe("chat channel client guards", () => {
  it("guards configure and leaves reads open to readers", () => {
    for (const method of [WS_METHODS.imessageChannelConfigure, WS_METHODS.telegramChannelConfigure])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    for (const method of [
      WS_METHODS.imessageChannelGetSettings,
      WS_METHODS.imessageChannelSubscribeStatus,
      WS_METHODS.imessageChannelCheckAccess,
      WS_METHODS.telegramChannelGetSettings,
      WS_METHODS.telegramChannelSubscribeStatus,
    ])
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)).toBe(false);
  });
});

describe("Claude in Chrome client guards", () => {
  it("guards the default toggle with provider management and leaves the status read open", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.providerClaudeChromeSetDefault, {})).toEqual([
      "providers:manage",
    ]);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.providerClaudeChromeStatus)).toBe(
      false,
    );
  });
});

describe("heavy queue client guards", () => {
  it("guards every queue change, switching it off included, and leaves the subscription open", () => {
    for (const method of [
      WS_METHODS.heavyQueuePromote,
      WS_METHODS.heavyQueueStartNow,
      WS_METHODS.heavyQueueCancel,
      WS_METHODS.heavyQueueMove,
      WS_METHODS.heavyQueueSetPaused,
      WS_METHODS.heavyQueueSetEnabled,
      WS_METHODS.heavyQueueSetRule,
      WS_METHODS.heavyQueueRoute,
      WS_METHODS.heavyQueueRouteAll,
      WS_METHODS.heavyQueueForgetRoutes,
      WS_METHODS.heavyQueueSetMaxRunning,
      WS_METHODS.heavyQueueSetMacMemoryFloorPercent,
      WS_METHODS.heavyQueueSetMacCpuCeilingPercent,
      WS_METHODS.heavyQueueSetHeavyOverLimitSeconds,
      WS_METHODS.heavyQueueSetAdmissionLimits,
      WS_METHODS.heavyQueueStopCommand,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["terminal:operate"]);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.heavyQueueSubscribe)).toBe(false);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.heavyQueueListRoutes)).toBe(false);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.heavyQueueSubscribeCommands)).toBe(
      false,
    );
  });
});

describe("file explorer client guards", () => {
  it("guards entry changes with filesystem write, as saving a file needs", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectsChangeEntry, {})).toEqual([
      "filesystem:write",
    ]);
  });
});

describe("integration client guards", () => {
  it("guards every credential change with settings write and leaves the subscription open", () => {
    for (const method of [
      WS_METHODS.integrationsBeginConnect,
      WS_METHODS.integrationsCompleteConnect,
      WS_METHODS.integrationsCancelConnect,
      WS_METHODS.integrationsDisconnect,
      WS_METHODS.integrationsSaveToken,
      WS_METHODS.integrationsSaveOwnApp,
      WS_METHODS.integrationsRemoveOwnApp,
      WS_METHODS.integrationsUpdate,
      WS_METHODS.integrationsMakeAvailable,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.integrationsSubscribe)).toBe(false);
  });
});

describe("settings client guards", () => {
  const remove = {
    operation: "remove",
    instanceId: ProviderInstanceId.make("codex_work"),
  } as const;
  it.each([
    ["no payload", undefined, ["settings:write"]],
    ["an empty patch", { patch: {} }, ["settings:write"]],
    // A spread optional field can arrive as an explicit undefined; it changes nothing.
    ["an undefined field", { patch: { defaultRuntimeMode: undefined } }, ["settings:write"]],
    ["a settings field", { patch: { defaultRuntimeMode: "full-access" } }, ["settings:write"]],
    ["a provider field", { patch: { providerInstances: {} } }, ["providers:manage"]],
    [
      "both",
      { patch: { defaultRuntimeMode: "full-access", providerInstances: {} } },
      ["settings:write", "providers:manage"],
    ],
    [
      "a removed secret provider",
      { patch: { secretProviders: { personal: null } } },
      ["settings:write", "providers:manage"],
    ],
    ["a provider mutation", { patch: {}, providerInstanceMutation: remove }, ["providers:manage"]],
    [
      "a mutation and a settings field",
      { patch: { defaultRuntimeMode: "full-access" }, providerInstanceMutation: remove },
      ["settings:write", "providers:manage"],
    ],
  ])("server.updateSettings with %s", (_case, input, scopes) =>
    expect(clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, input)).toEqual(scopes),
  );
});

describe("payload branches", () => {
  const remove = { operation: "remove", instanceId: "codex_work" };
  const thread = "thread-1";
  const branches: ReadonlyArray<readonly [method: string, label: string, payload: unknown]> = [
    ...Object.keys(RPC_REQUIRED_SCOPES).map((method) => [method, "no payload", undefined] as const),
    [WS_METHODS.serverUpdateSettings, "settings field", { patch: { defaultRuntimeMode: "x" } }],
    [WS_METHODS.serverUpdateSettings, "provider field", { patch: { providerInstances: {} } }],
    [
      WS_METHODS.serverUpdateSettings,
      "removed secret provider",
      { patch: { secretProviders: { a: null } } },
    ],
    [
      WS_METHODS.serverUpdateSettings,
      "mutation alone",
      { patch: {}, providerInstanceMutation: remove },
    ],
    [
      WS_METHODS.serverUpdateSettings,
      "mutation and settings field",
      { patch: { defaultRuntimeMode: "x" }, providerInstanceMutation: remove },
    ],
    [WS_METHODS.projectsMutate, "delete", { type: "project.delete" }],
    [WS_METHODS.projectsMutate, "update with scripts", { type: "project.update", scripts: [] }],
    [WS_METHODS.assetsCreateUrl, "workspace file", { resource: { _tag: "workspace-file" } }],
    [WS_METHODS.assetsCreateUrl, "media file", { resource: { _tag: "media-file" } }],
    [
      WS_METHODS.assetsCreateUrl,
      "draft workspace file",
      { resource: { _tag: "draft-workspace-file" } },
    ],
    [
      WS_METHODS.assetsCreateUrl,
      "app icon by path",
      { resource: { _tag: "native-app-icon", app: { _tag: "app-path" } } },
    ],
    [
      WS_METHODS.assetsCreateUrl,
      "app icon by tool",
      { resource: { _tag: "native-app-icon", app: { _tag: "tool" } } },
    ],
    [WS_METHODS.assetsCreateUrl, "attachment", { resource: { _tag: "attachment" } }],
    [WS_METHODS.deviceList, "list", {}],
    [WS_METHODS.deviceList, "inspect", { inspectOnly: true }],
    [WS_METHODS.deviceList, "inspect with a retry host", { inspectOnly: true, retryHostId: "h" }],
    [WS_METHODS.deviceList, "retry", { retryHostId: "h" }],
    [WS_METHODS.deviceList, "update", { updateTool: "hub" }],
    [WS_METHODS.deviceList, "inspect and update", { inspectOnly: true, updateTool: "agent" }],
    [
      WS_METHODS.gitPreparePullRequestThread,
      "worktree for a thread",
      { mode: "worktree", threadId: thread },
    ],
    [WS_METHODS.gitPreparePullRequestThread, "local", { mode: "local" }],
    [
      WS_METHODS.gitRunStackedAction,
      "pull request for a thread",
      { action: "create_pr", threadId: thread },
    ],
    [WS_METHODS.gitRunStackedAction, "commit", { action: "commit" }],
  ];
  // Branches that replace the base scope, as the server's authorization always has.
  const replacesBase = new Map<string, string>([
    [
      `${WS_METHODS.serverUpdateSettings} provider field`,
      "provider settings need providers:manage, not settings:write",
    ],
    [
      `${WS_METHODS.serverUpdateSettings} mutation alone`,
      "a provider instance change alone needs only providers:manage",
    ],
    [
      `${WS_METHODS.assetsCreateUrl} workspace file`,
      "file assets need filesystem:read, not transcript access",
    ],
    [
      `${WS_METHODS.assetsCreateUrl} media file`,
      "file assets need filesystem:read, not transcript access",
    ],
    [
      `${WS_METHODS.assetsCreateUrl} draft workspace file`,
      "file assets need filesystem:read, not transcript access",
    ],
    [
      `${WS_METHODS.assetsCreateUrl} app icon by path`,
      "reading an app bundle is a filesystem read",
    ],
  ]);

  it.each(branches)("%s with %s keeps the base scope", (method, label, payload) => {
    const base = RPC_REQUIRED_SCOPES[method as keyof typeof RPC_REQUIRED_SCOPES];
    const scopes = rpcRequiredScopes(method, payload);
    if (replacesBase.has(`${method} ${label}`)) expect(scopes).not.toContain(base);
    else expect(scopes).toContain(base);
  });
});
