import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./server", () => ({
  environmentServerConfigsAtom: Atom.make(new Map<string, unknown>()),
}));

import { computerUseHostEnvironmentIdsAtom, macEnvironmentIdsAtom } from "./macPermissions";
import { environmentServerConfigsAtom } from "./server";

const config = (os: string) => ({ environment: { platform: { os } } });

describe("macEnvironmentIdsAtom", () => {
  it("lists only Mac environments and keeps the same list while they are unchanged", () => {
    const registry = AtomRegistry.make();
    registry.mount(macEnvironmentIdsAtom);
    const configs = environmentServerConfigsAtom as unknown as Atom.Writable<Map<string, unknown>>;
    registry.set(
      configs,
      new Map([
        ["mac", config("darwin")],
        ["box", config("linux")],
      ]),
    );
    const first = registry.get(macEnvironmentIdsAtom);
    expect(first).toEqual(["mac"]);
    // A Windows or Linux host goes to the Computer use page, never to both.
    expect(registry.get(computerUseHostEnvironmentIdsAtom)).toEqual(["box"]);
    registry.set(
      configs,
      new Map([
        ["mac", config("darwin")],
        ["other", config("win32")],
      ]),
    );
    expect(registry.get(macEnvironmentIdsAtom)).toBe(first);
    registry.set(configs, new Map([["laptop", config("darwin")]]));
    expect(registry.get(macEnvironmentIdsAtom)).toEqual(["laptop"]);
    registry.dispose();
  });
});
