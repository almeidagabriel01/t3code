import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { getOpenAtLogin, openLoginItemsSettings, setOpenAtLogin } from "./openAtLogin.ts";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("electron", () => ({ shell: { openExternal } }));

const layerFor = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform,
      isPackaged: false,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    DesktopAppSettings.layerTest(),
    Layer.mock(ElectronApp.ElectronApp, {}),
  );

describe("open at login IPC", () => {
  it.effect("reads and changes the setting without touching an unpackaged build's system", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* getOpenAtLogin.handler(undefined), {
        enabled: true,
        platform: "darwin",
        status: null,
      });
      assert.deepEqual(yield* setOpenAtLogin.handler(false), {
        enabled: false,
        platform: "darwin",
        status: null,
      });
    }).pipe(Effect.provide(layerFor("darwin"))),
  );

  it.effect.each([
    ["darwin", "resolves", true, 1],
    ["darwin", "rejects", false, 1],
    ["win32", "resolves", false, 0],
  ] as const)("opens Login Items on %s when the shell %s", ([platform, outcome, opened, calls]) =>
    Effect.gen(function* () {
      openExternal.mockReset();
      openExternal.mockImplementation(() =>
        outcome === "resolves" ? Promise.resolve() : Promise.reject(new Error("no")),
      );
      assert.equal(yield* openLoginItemsSettings.handler(undefined), opened);
      assert.equal(openExternal.mock.calls.length, calls);
      if (calls > 0) {
        assert.deepEqual(openExternal.mock.calls[0], [
          "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        ]);
      }
    }).pipe(Effect.provide(layerFor(platform))),
  );
});
