import { describe, expect, it, vi } from "vite-plus/test";

const { constants } = vi.hoisted(() => ({
  constants: { expoConfig: { scheme: "t3code-dev" as unknown } },
}));
vi.mock("expo-constants", () => ({ default: constants }));

import { appAtomRegistry } from "../../state/atom-registry";
import {
  appReturnScheme,
  cancelConnectFlow,
  completePastedConnect,
  pendingFlowFor,
  pendingFlowsAtom,
  startConnect,
  type ConnectDeps,
} from "./connectFlow";

const begun = (mode: "server" | "paste" | "loopback") => ({
  ok: true as const,
  value: {
    flowId: "f1",
    name: "linear",
    authorizationUrl: "https://auth.example/authorize",
    mode,
    redirectUri: "https://host/oauth/integrations/callback",
    expiresAt: 1,
  },
});

const deps = (overrides: Partial<ConnectDeps> = {}): ConnectDeps => ({
  environmentId: "hub" as never,
  scheme: "t3code-dev",
  begin: vi.fn().mockResolvedValue(begun("server")),
  complete: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  cancel: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  openAuthSession: vi.fn().mockResolvedValue({ type: "cancel" }),
  openBrowser: vi.fn().mockResolvedValue({}),
  waitForConnection: vi.fn().mockResolvedValue("https://box.tail.ts.net/"),
  ...overrides,
});

const pending = () =>
  pendingFlowFor(appAtomRegistry.get(pendingFlowsAtom), "hub" as never, "linear");

describe("appReturnScheme", () => {
  it.each([
    ["t3code-dev", "t3code-dev"],
    ["t3code-preview", "t3code-preview"],
    [["t3code-preview", "other"], "t3code-preview"],
    ["t3code", "t3code"],
    [undefined, "t3code"],
    ["elsewhere", "t3code"],
  ])("%j returns to %s", (scheme, expected) => {
    constants.expoConfig.scheme = scheme;
    expect(appReturnScheme()).toBe(expected);
  });
});

describe("startConnect", () => {
  it("reports the base URL's origin and the scheme, and refuses with the server's reason", async () => {
    const begin = vi.fn().mockResolvedValue({ ok: false, reason: "own-app-required" });
    expect(await startConnect("linear", deps({ begin }))).toEqual({
      kind: "failed",
      reason: "own-app-required",
    });
    expect(begin).toHaveBeenCalledWith({
      catalogId: "linear",
      client: { kind: "mobile", origin: "https://box.tail.ts.net", returnScheme: "t3code-dev" },
    });
  });

  it("leaves the origin out when the socket never came back", async () => {
    const begin = vi.fn().mockResolvedValue({ ok: false, reason: "unreachable" });
    await startConnect("linear", deps({ begin, waitForConnection: async () => null }));
    expect(begin.mock.calls[0]?.[0].client).toEqual({ kind: "mobile", returnScheme: "t3code-dev" });
  });

  it.each([
    ["t3code-dev://integrations/done?result=connected", { kind: "connected", name: "linear" }],
    ["t3code-dev://integrations/done?result=failed", { kind: "failed", reason: null }],
  ])("server mode returning to %s settles without cancelling", async (url, outcome) => {
    const d = deps({ openAuthSession: vi.fn().mockResolvedValue({ type: "success", url }) });
    expect(await startConnect("linear", d)).toEqual(outcome);
    expect(d.openAuthSession).toHaveBeenCalledWith(
      "https://auth.example/authorize",
      "t3code-dev://integrations/done",
    );
    expect(d.cancel).not.toHaveBeenCalled();
    expect(pending()).toBeNull();
  });

  it.each(["cancel", "dismiss"])(
    "a sheet closed with %s cancels the flow after the reconnect",
    async (type) => {
      const order: string[] = [];
      const d = deps({
        openAuthSession: vi.fn().mockResolvedValue({ type }),
        waitForConnection: vi.fn(async () => {
          order.push("wait");
          return "https://box.tail.ts.net";
        }),
        cancel: vi.fn(async () => {
          order.push("cancel");
          return { ok: true as const, value: undefined };
        }),
      });
      expect(await startConnect("linear", d)).toEqual({ kind: "cancelled" });
      expect(d.cancel).toHaveBeenCalledWith("f1");
      expect(order).toEqual(["wait", "wait", "cancel"]);
      expect(pending()).toBeNull();
    },
  );

  it.each(["paste", "loopback"] as const)(
    "%s mode opens the browser and keeps the flow for the paste step",
    async (mode) => {
      const d = deps({ begin: vi.fn().mockResolvedValue(begun(mode)) });
      const outcome = await startConnect("linear", d);
      expect(outcome.kind).toBe("paste");
      expect(d.openBrowser).toHaveBeenCalledWith("https://auth.example/authorize");
      expect(d.openAuthSession).not.toHaveBeenCalled();
      expect(pending()).toMatchObject({ flowId: "f1", catalogId: "linear", mode });
    },
  );
});

describe("pasted callbacks", () => {
  const flow = {
    environmentId: "hub" as never,
    catalogId: "linear",
    flowId: "f1",
    name: "linear",
    mode: "paste" as const,
    authorizationUrl: "https://auth.example/authorize",
  };

  it("refuses text that is not a sign-in answer without calling the server", async () => {
    const d = deps();
    expect(await completePastedConnect(flow, "hello", d)).toEqual({
      ok: false,
      reason: "invalid-callback",
    });
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("completes the flow with the pasted address and forgets it", async () => {
    await startConnect("linear", deps({ begin: vi.fn().mockResolvedValue(begun("paste")) }));
    const d = deps();
    const url = "http://127.0.0.1:4/integrations/callback?code=c&state=s";
    expect(await completePastedConnect(flow, `  ${url} `, d)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(d.complete).toHaveBeenCalledWith({ flowId: "f1", callbackUrl: url });
    expect(pending()).toBeNull();
  });

  it("keeps the flow when the server refuses the address", async () => {
    await startConnect("linear", deps({ begin: vi.fn().mockResolvedValue(begun("paste")) }));
    const d = deps({
      complete: vi.fn().mockResolvedValue({ ok: false, reason: "sign-in-expired" }),
    });
    expect(
      await completePastedConnect(flow, "http://127.0.0.1:4/integrations/callback?error=x", d),
    ).toEqual({ ok: false, reason: "sign-in-expired" });
    expect(pending()).not.toBeNull();
    await cancelConnectFlow(flow, d);
    expect(pending()).toBeNull();
  });
});
