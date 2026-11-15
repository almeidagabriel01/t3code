import { sessionScopeAccess } from "@t3tools/client-runtime/state/sessionScope";
import {
  AuthProvidersManageScope,
  ProjectId,
  ProviderInstanceId,
  type AuthSessionState,
  type ServerSettings,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_SETTINGS_SCOPES,
  buildProviderInstanceOverridePatch,
  classifyProviderEnvironmentAccess,
} from "./ProviderSettingsPanel.logic";

describe("buildProviderInstanceOverridePatch", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");

  it("writes the same choice to every checkout of the project", () => {
    const siblingId = ProjectId.make("project-a-worktree");
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [siblingId]: { newWorktreesStartFromOrigin: true },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId, siblingId], instanceId, false),
    ).toEqual({
      [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      [siblingId]: {
        newWorktreesStartFromOrigin: true,
        providerInstances: { [instanceId]: { enabled: false } },
      },
    });
  });

  it("resets the only override by clearing the whole project entry", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({ [projectId]: null });
  });

  it("sends providerInstances: {} explicitly when clearing the last instance override leaves other keys", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: true } },
        },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({
      [projectId]: { newWorktreesStartFromOrigin: true, providerInstances: {} },
    });
  });
});

describe("classifyProviderEnvironmentAccess", () => {
  const classify = (
    operateAccess: Parameters<typeof classifyProviderEnvironmentAccess>[0]["operateAccess"],
    overrides: Partial<Parameters<typeof classifyProviderEnvironmentAccess>[0]> = {},
  ) =>
    classifyProviderEnvironmentAccess({
      connectionPhase: "connected",
      hasServerConfig: true,
      operateAccess,
      ...overrides,
    });

  it.each([
    ["unknown", { kind: "loading", reason: "permissions" }],
    ["unavailable", { kind: "read-only" }],
    ["missing", { kind: "read-only" }],
    ["granted", { kind: "editable" }],
  ] as const)("operate access %s", (access, expected) => {
    expect(classify(access)).toEqual(expected);
  });

  it("waits for config and reports connection problems before access", () => {
    expect(classify("granted", { hasServerConfig: false })).toEqual({
      kind: "loading",
      reason: "config",
    });
    expect(classify("granted", { connectionPhase: "error" })).toEqual({ kind: "error" });
  });
});

describe("remote operate access", () => {
  const session = (value: Record<string, unknown>) =>
    AsyncResult.success(value as unknown as AuthSessionState);
  const classifySession = (result: AsyncResult.AsyncResult<AuthSessionState, unknown>) =>
    classifyProviderEnvironmentAccess({
      connectionPhase: "connected",
      hasServerConfig: true,
      operateAccess: sessionScopeAccess(result, PROVIDER_SETTINGS_SCOPES),
    }).kind;

  it("does not treat the old orchestration grant as provider management", () => {
    expect(
      classifySession(
        session({
          authenticated: true,
          scopes: ["orchestration:operate"],
          auth: { serverUpdateScope: "environment:maintain" },
        }),
      ),
    ).toBe("read-only");
  });

  it("accepts the orchestration grant from a server that predates providers:manage", () => {
    expect(
      classifySession(
        session({ authenticated: true, scopes: ["orchestration:operate"], auth: {} }),
      ),
    ).toBe("editable");
  });

  it("derives access from the environment session's granted scopes", () => {
    expect(
      classifySession(session({ authenticated: true, scopes: [AuthProvidersManageScope] })),
    ).toBe("editable");
    expect(classifySession(session({ authenticated: true, scopes: ["orchestration:read"] }))).toBe(
      "read-only",
    );
    expect(classifySession(session({ authenticated: false }))).toBe("read-only");
  });

  it("opens read-only when the session check failed with no session", () => {
    expect(classifySession(AsyncResult.fail(new Error("no session")))).toBe("read-only");
    expect(classifySession(AsyncResult.initial<AuthSessionState>())).toBe("loading");
  });
});
