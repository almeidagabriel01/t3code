import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  RelayConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  environmentMcpUrl,
  environmentReachable,
  environmentReconnected,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("copies the T3 Connect MCP address first, then the route this device is connected over", () => {
    const route = (connectionId: string, httpBaseUrl: string): ConnectionRoute => {
      const target = new BearerConnectionTarget({ ...TARGET, connectionId });
      return {
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId,
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
          }),
        ),
      };
    };
    const lan = route("lan", "http://192.168.4.53:3773/");
    const tailnet = route("tailnet", "http://100.115.1.44:3773/");
    const serve = route("serve", "https://machine.tailnet.ts.net/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: lan.target,
      profile: lan.profile,
      alternateRoutes: [tailnet, serve],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: tailnet.target })).toBe(
      "http://100.115.1.44:3773/mcp",
    );
    expect(environmentMcpUrl({ entry })).toBe("http://192.168.4.53:3773/mcp");
    expect(
      environmentMcpUrl({
        entry,
        connectedTarget: lan.target,
        relayHttpBaseUrl: "https://tunnel.example.test",
      }),
    ).toBe("https://tunnel.example.test/mcp");
  });

  // regression: #16909 Copy MCP URL falls back to an alternate route when the relay route has no address
  it("passes over routes without an address of their own", () => {
    const relay = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
    });
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: relay,
      profile: Option.none(),
      alternateRoutes: [{ target: ENTRY.target, profile: ENTRY.profile }],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: relay })).toBe(
      "https://environment.example.test/mcp",
    );
    expect(
      environmentMcpUrl({
        entry,
        connectedTarget: relay,
        relayHttpBaseUrl: "https://tunnel.example.test",
      }),
    ).toBe("https://tunnel.example.test/mcp");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it.each([
    ["connected", true],
    ["offline", false],
    ["reconnecting", false],
    ["error", false],
    ["unsupported", false],
    // Before the first attempt settles nothing is known, so nothing says "disconnected" yet.
    ["available", null],
    ["connecting", null],
  ] as const)("a %s environment is reachable: %s", (phase, expected) => {
    expect(environmentReachable({ phase })).toBe(expected);
  });
  it("an environment with no presentation yet is unknown", () => {
    expect(environmentReachable(null)).toBe(null);
  });

  it.each([
    [false, true, true],
    [null, true, true],
    [true, true, false],
    [true, false, false],
    [false, false, false],
    [false, null, false],
  ] as const)("reachable %s then %s is a reconnect: %s", (previous, current, expected) => {
    expect(environmentReconnected(previous, current)).toBe(expected);
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentConnectionState(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});
