import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes, CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
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
  it("guards answering and dismissing, and leaves reads open to readers", () => {
    for (const method of [WS_METHODS.decisionsAnswer, WS_METHODS.decisionsDismiss])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    for (const method of [WS_METHODS.decisionsList, WS_METHODS.decisionsSubscribe])
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)).toBe(false);
  });
});

describe("assistant client guards", () => {
  it("guards every assistant mutation and leaves the subscription open to readers", () => {
    for (const method of [
      WS_METHODS.assistantsCreate,
      WS_METHODS.assistantsUpdate,
      WS_METHODS.assistantsDelete,
      WS_METHODS.assistantsReset,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.assistantsSubscribe)).toBe(false);
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
