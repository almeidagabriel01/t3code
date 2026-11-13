import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLoginItem from "./DesktopLoginItem.ts";

type MacStatus = Electron.LoginItemSettings["status"];

const loginItem = (fields: Partial<Electron.LoginItemSettings>) =>
  ({
    openAtLogin: false,
    wasOpenedAtLogin: false,
    status: "not-registered",
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...fields,
  }) as Electron.LoginItemSettings;

/** A fake system login item: registering enables it unless `registrationFails`. */
function makeSystem(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly status: MacStatus;
  readonly openAtLogin: boolean;
  readonly openAtLoginRegistered?: boolean;
  readonly registrationFails?: boolean;
  readonly wasOpenedAtLogin?: boolean;
}) {
  let status = input.status;
  const calls: Array<Electron.Settings> = [];
  const reads: Array<Electron.LoginItemSettingsOptions | undefined> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      platform: input.platform,
      isPackaged: input.isPackaged,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    DesktopAppSettings.layerTest({
      ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
      openAtLogin: input.openAtLogin,
      openAtLoginRegistered: input.openAtLoginRegistered ?? false,
    }),
    Layer.mock(ElectronApp.ElectronApp, {
      getLoginItemSettings: (options) =>
        Effect.sync(() => {
          reads.push(options);
          return loginItem({
            status,
            openAtLogin: status !== "not-registered",
            executableWillLaunchAtLogin: status === "enabled",
            wasOpenedAtLogin: input.wasOpenedAtLogin ?? false,
          });
        }),
      setLoginItemSettings: (settings) =>
        Effect.sync(() => {
          calls.push(settings);
          if (!settings.openAtLogin) status = "not-registered";
          else if (!input.registrationFails) status = "enabled";
        }),
    }),
  );
  return { layer, calls, reads };
}

const settingsOf = Effect.gen(function* () {
  const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
  return { openAtLogin: settings.openAtLogin, registered: settings.openAtLoginRegistered };
});

describe("DesktopLoginItem", () => {
  // setting × registered before × system status × packaged → system call, setting after, status shown.
  const cases = [
    ["on", false, "enabled", true, "none", true, "enabled"],
    ["on", false, "requires-approval", true, "none", true, "requires-approval"],
    ["on", false, "not-registered", true, "register", true, "enabled"],
    ["on", false, "not-found", true, "register", true, "enabled"],
    ["on", true, "not-registered", true, "none", false, "not-registered"],
    ["off", false, "enabled", true, "unregister", false, "not-registered"],
    ["off", false, "requires-approval", true, "unregister", false, "not-registered"],
    ["off", false, "not-registered", true, "none", false, "not-registered"],
    ["on", false, "enabled", false, "none", true, null],
    ["on", false, "requires-approval", false, "none", true, null],
    ["on", false, "not-registered", false, "none", true, null],
    ["off", false, "enabled", false, "none", false, null],
    ["off", false, "requires-approval", false, "none", false, null],
    ["off", false, "not-registered", false, "none", false, null],
  ] as const;

  it.effect.each(cases)(
    "setting %s (registered before: %s) with the item %s, packaged %s: %s",
    ([setting, registeredBefore, status, isPackaged, action, enabledAfter, statusAfter]) =>
      Effect.gen(function* () {
        const system = makeSystem({
          platform: "darwin",
          isPackaged,
          status,
          openAtLogin: setting === "on",
          openAtLoginRegistered: registeredBefore,
        });
        yield* Effect.gen(function* () {
          const state = yield* DesktopLoginItem.reconcileOpenAtLogin();
          assert.deepEqual(state, {
            enabled: enabledAfter,
            platform: "darwin",
            status: statusAfter,
          });
          assert.deepEqual(
            system.calls,
            action === "none" ? [] : [{ openAtLogin: action === "register" }],
          );
          if (!isPackaged) assert.deepEqual(system.reads, []);
          const after = yield* settingsOf;
          assert.equal(after.openAtLogin, enabledAfter);
          assert.equal(after.registered, isPackaged && statusAfter !== "not-registered");
          // Idempotent: a second pass changes nothing.
          const callsBefore = system.calls.length;
          assert.deepEqual(yield* DesktopLoginItem.reconcileOpenAtLogin(), state);
          assert.equal(system.calls.length, callsBefore);
        }).pipe(Effect.provide(system.layer));
      }),
  );

  it.effect("keeps the setting on but unconfirmed when registration fails silently", () =>
    Effect.gen(function* () {
      const system = makeSystem({
        platform: "darwin",
        isPackaged: true,
        status: "not-registered",
        openAtLogin: true,
        registrationFails: true,
      });
      yield* Effect.gen(function* () {
        assert.deepEqual(yield* DesktopLoginItem.reconcileOpenAtLogin(), {
          enabled: true,
          platform: "darwin",
          status: "not-registered",
        });
        assert.deepEqual(yield* settingsOf, { openAtLogin: true, registered: false });
        // Unconfirmed, so the next startup tries again rather than reading it as a removal.
        yield* DesktopLoginItem.reconcileOpenAtLogin();
        assert.equal(system.calls.length, 2);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("re-registers when the user turns it back on after removing it in the system", () =>
    Effect.gen(function* () {
      const system = makeSystem({
        platform: "darwin",
        isPackaged: true,
        status: "not-registered",
        openAtLogin: true,
        openAtLoginRegistered: true,
      });
      yield* Effect.gen(function* () {
        assert.isFalse((yield* DesktopLoginItem.reconcileOpenAtLogin())?.enabled);
        assert.deepEqual(yield* DesktopLoginItem.setOpenAtLogin(true), {
          enabled: true,
          platform: "darwin",
          status: "enabled",
        });
        assert.deepEqual(yield* DesktopLoginItem.setOpenAtLogin(false), {
          enabled: false,
          platform: "darwin",
          status: "not-registered",
        });
        assert.deepEqual(system.calls, [{ openAtLogin: true }, { openAtLogin: false }]);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("registers on Windows with the login launch marker", () =>
    Effect.gen(function* () {
      const system = makeSystem({
        platform: "win32",
        isPackaged: true,
        status: "not-registered",
        openAtLogin: true,
      });
      yield* Effect.gen(function* () {
        assert.deepEqual(yield* DesktopLoginItem.reconcileOpenAtLogin(), {
          enabled: true,
          platform: "win32",
          status: "enabled",
        });
        assert.deepEqual(system.calls, [{ args: ["--opened-at-login"], openAtLogin: true }]);
        assert.deepEqual(system.reads[0], { args: ["--opened-at-login"] });
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("has no login item on Linux", () =>
    Effect.gen(function* () {
      const system = makeSystem({
        platform: "linux",
        isPackaged: true,
        status: "not-registered",
        openAtLogin: true,
      });
      yield* Effect.gen(function* () {
        assert.isNull(yield* DesktopLoginItem.reconcileOpenAtLogin());
        assert.deepEqual(system.reads, []);
        assert.deepEqual(system.calls, []);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.each([
    ["darwin", loginItem({ status: "enabled" }), "enabled"],
    ["darwin", loginItem({ status: "requires-approval" }), "requires-approval"],
    ["darwin", loginItem({ status: "not-registered" }), "not-registered"],
    ["darwin", loginItem({ status: "not-found" }), "not-registered"],
    ["win32", loginItem({ openAtLogin: true, executableWillLaunchAtLogin: true }), "enabled"],
    [
      "win32",
      loginItem({ openAtLogin: true, executableWillLaunchAtLogin: false }),
      "requires-approval",
    ],
    ["win32", loginItem({ openAtLogin: false }), "not-registered"],
  ] as const)("reads %s item %j as %s", (platform, item, expected) => {
    assert.equal(DesktopLoginItem.loginItemStatusOf(platform, item), expected);
  });

  // platform × packaged × launch signal → starts hidden.
  it.effect.each([
    ["darwin", true, true, [], true],
    ["darwin", true, false, [], false],
    ["darwin", false, true, [], false],
    ["win32", true, false, ["T3 Code.exe", "--opened-at-login"], true],
    ["win32", true, false, ["T3 Code.exe"], false],
    ["win32", false, false, ["T3 Code.exe", "--opened-at-login"], false],
    ["linux", true, true, ["t3code", "--opened-at-login"], false],
  ] as const)(
    "%s packaged %s (opened at login %s, argv %j) starts hidden: %s",
    ([platform, isPackaged, wasOpenedAtLogin, argv, expected]) =>
      Effect.gen(function* () {
        const system = makeSystem({
          platform,
          isPackaged,
          status: "enabled",
          openAtLogin: true,
          wasOpenedAtLogin,
        });
        const hidden = yield* DesktopLoginItem.openedAtLogin.pipe(
          Effect.provide(system.layer),
          Effect.provideService(HostProcess.Arguments, argv),
        );
        assert.equal(hidden, expected);
      }),
  );
});
