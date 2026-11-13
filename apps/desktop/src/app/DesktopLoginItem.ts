import type { DesktopOpenAtLoginState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// Windows has no "opened at login" flag, so the Run entry passes this marker.
export const OPENED_AT_LOGIN_ARG = "--opened-at-login";

type LoginItemPlatform = DesktopOpenAtLoginState["platform"];
export type LoginItemStatus = NonNullable<DesktopOpenAtLoginState["status"]>;
export type LoginItemAction = "register" | "unregister" | "none";

const loginItemPlatformOf = (platform: NodeJS.Platform): LoginItemPlatform | null =>
  platform === "darwin" || platform === "win32" ? platform : null;

const loginItemOptions = (platform: LoginItemPlatform) =>
  platform === "win32" ? { args: [OPENED_AT_LOGIN_ARG] } : {};

export function loginItemStatusOf(
  platform: LoginItemPlatform,
  item: Electron.LoginItemSettings,
): LoginItemStatus {
  if (platform === "darwin") {
    return item.status === "enabled" || item.status === "requires-approval"
      ? item.status
      : "not-registered";
  }
  if (!item.openAtLogin) return "not-registered";
  // A Run entry switched off in Task Manager is the Windows form of "requires approval".
  return item.executableWillLaunchAtLogin ? "enabled" : "requires-approval";
}

function planLoginItem(
  settings: DesktopAppSettings.DesktopOpenAtLoginSettings,
  status: LoginItemStatus,
): {
  readonly action: LoginItemAction;
  readonly settings: DesktopAppSettings.DesktopOpenAtLoginSettings;
} {
  if (!settings.openAtLogin) {
    return {
      action: status === "not-registered" ? "none" : "unregister",
      settings: { openAtLogin: false, openAtLoginRegistered: false },
    };
  }
  if (status !== "not-registered") {
    return { action: "none", settings: { openAtLogin: true, openAtLoginRegistered: true } };
  }
  // The system lost an item it had confirmed: the user removed it there, so follow them.
  if (settings.openAtLoginRegistered) {
    return { action: "none", settings: { openAtLogin: false, openAtLoginRegistered: false } };
  }
  return { action: "register", settings };
}

/** Brings the system login item in line with the setting; never touches it from unpackaged builds. */
export const reconcileOpenAtLogin = Effect.fn("desktop.loginItem.reconcile")(
  function* (): Effect.fn.Return<
    DesktopOpenAtLoginState | null,
    DesktopAppSettings.DesktopSettingsWriteError,
    | DesktopEnvironment.DesktopEnvironment
    | DesktopAppSettings.DesktopAppSettings
    | ElectronApp.ElectronApp
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const platform = loginItemPlatformOf(environment.platform);
    if (platform === null) return null;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const settings = yield* appSettings.get;
    if (!environment.isPackaged) {
      return { enabled: settings.openAtLogin, platform, status: null };
    }

    const electronApp = yield* ElectronApp.ElectronApp;
    const options = loginItemOptions(platform);
    const readStatus = electronApp
      .getLoginItemSettings(options)
      .pipe(Effect.map((item) => loginItemStatusOf(platform, item)));
    let status = yield* readStatus;
    const plan = planLoginItem(settings, status);
    let next = plan.settings;
    if (plan.action !== "none") {
      yield* electronApp.setLoginItemSettings({
        ...options,
        openAtLogin: plan.action === "register",
      });
      // Registration can fail silently, for example in an unsigned build.
      status = yield* readStatus;
      if (plan.action === "register") {
        next = { openAtLogin: true, openAtLoginRegistered: status !== "not-registered" };
      }
    }
    yield* appSettings.setOpenAtLogin(next);
    return { enabled: next.openAtLogin, platform, status };
  },
);

export const setOpenAtLogin = Effect.fn("desktop.loginItem.set")(function* (enabled: boolean) {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  // An explicit choice starts fresh: turning it on registers even after a removal in the system.
  yield* appSettings.setOpenAtLogin({ openAtLogin: enabled, openAtLoginRegistered: false });
  return yield* reconcileOpenAtLogin();
});

/** Whether this process is a launch at login, which starts without showing a window. */
export const openedAtLogin = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) return false;
  if (environment.platform === "darwin") {
    const electronApp = yield* ElectronApp.ElectronApp;
    return (yield* electronApp.getLoginItemSettings()).wasOpenedAtLogin;
  }
  if (environment.platform === "win32") {
    return (yield* HostProcess.Arguments).includes(OPENED_AT_LOGIN_ARG);
  }
  return false;
}).pipe(Effect.withSpan("desktop.loginItem.openedAtLogin"));
