import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: vi.fn() }));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const { Layer } = await import("effect");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("./session", () => ({ environmentSession: {}, sessionHasScope: () => false }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));

import { useAtomValue } from "@effect/atom-react";

import { useAtomCommand } from "./use-atom-command";
import { integrationReply, useIntegrationActions, useIntegrationsState } from "./integrations";

describe("integrationReply", () => {
  it.each([
    [
      { _tag: "Success", value: 1 },
      { ok: true, value: 1 },
    ],
    [
      { _tag: "Failure", cause: Cause.fail({ _tag: "IntegrationError", reason: "unreachable" }) },
      { ok: false, reason: "unreachable" },
    ],
    [
      { _tag: "Failure", cause: Cause.fail(new Error("socket")) },
      { ok: false, reason: "" },
    ],
  ] as const)("%j settles to %j", (result, reply) => {
    expect(integrationReply(result as never)).toEqual(reply);
  });
});

describe("useIntegrationsState", () => {
  it("reads nothing for an environment without the capability", () => {
    vi.mocked(useAtomValue).mockReturnValueOnce(["hub"]).mockReturnValueOnce(null);
    expect(useIntegrationsState("other" as never)).toBeNull();
    vi.mocked(useAtomValue).mockReturnValueOnce(["hub"]).mockReturnValueOnce({ catalog: [] });
    expect(useIntegrationsState("hub" as never)).toEqual({ catalog: [] });
  });
});

describe("useIntegrationActions", () => {
  it("sends each change to its environment and settles it into a reply", async () => {
    const run = vi.fn().mockResolvedValue({ _tag: "Success", value: "ok" });
    vi.mocked(useAtomCommand).mockReturnValue(run as never);
    vi.mocked(useAtomValue).mockReturnValueOnce(true);
    const actions = useIntegrationActions("hub" as never);
    expect(actions.canAct).toBe(true);
    const calls: Array<[Promise<unknown>, unknown]> = [
      [
        actions.beginConnect({ catalogId: "x", client: { kind: "mobile" } }),
        { catalogId: "x", client: { kind: "mobile" } },
      ],
      [
        actions.completeConnect({ flowId: "f", callbackUrl: "u" }),
        { flowId: "f", callbackUrl: "u" },
      ],
      [actions.cancelConnect("x"), { name: "x" }],
      [actions.disconnect("x"), { name: "x" }],
      [actions.saveToken("x", "t"), { catalogId: "x", token: "t" }],
      [
        actions.saveOwnApp({ clientGroup: "g", clientId: "c" }),
        { clientGroup: "g", clientId: "c" },
      ],
      [actions.removeOwnApp("g"), { clientGroup: "g" }],
      [actions.update({ name: "x", availability: "all" }), { name: "x", availability: "all" }],
      [actions.makeAvailable("d"), { detectedId: "d" }],
    ];
    for (const [index, [reply, input]] of calls.entries()) {
      expect(await reply).toEqual({ ok: true, value: "ok" });
      expect(run.mock.calls[index]?.[0]).toEqual({ environmentId: "hub", input });
    }
  });
});
