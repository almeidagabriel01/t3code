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
