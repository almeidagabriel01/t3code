import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ targets: [] as unknown[] }));
vi.mock("@t3tools/client-runtime/device/stream", () => ({
  createDeviceStreamClient: (target: unknown) => {
    mocks.targets.push(target);
    return { start: () => undefined, stop: () => undefined };
  },
}));
vi.mock("~/state/device", () => ({ refreshDeviceHubAccess: () => undefined }));

import { deviceStreamSessionAtom } from "./deviceStreamSession";

const access = { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true };
const key = (capture: boolean, serveSimOnly = false) => ({
  environmentId: EnvironmentId.make("env"),
  hostId: "local",
  platform: "ios" as const,
  deviceId: capture ? "UDID" : "sim",
  access,
  serveSimOnly,
  capture,
  viewId: "view",
});

describe("deviceStreamSessionAtom targets", () => {
  it("a capture source streams video only and takes its size from /config", () => {
    mocks.targets.length = 0;
    const registry = AtomRegistry.make();
    const unmount = registry.mount(deviceStreamSessionAtom(key(true)));
    expect(mocks.targets[0]).toMatchObject({
      serveSimOnly: true,
      videoOnly: true,
      sizeFromConfig: true,
    });
    unmount();
  });

  it("a simulator target carries no capture flags", () => {
    mocks.targets.length = 0;
    const registry = AtomRegistry.make();
    const unmount = registry.mount(deviceStreamSessionAtom(key(false)));
    expect(mocks.targets[0]).toMatchObject({ serveSimOnly: false });
    expect(mocks.targets[0]).not.toHaveProperty("videoOnly");
    expect(mocks.targets[0]).not.toHaveProperty("sizeFromConfig");
    unmount();
  });
});
