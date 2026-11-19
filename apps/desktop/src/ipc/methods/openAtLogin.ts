import { DesktopOpenAtLoginStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLoginItem from "../../app/DesktopLoginItem.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const LOGIN_ITEMS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

// Reading reconciles too, so returning from System Settings shows what the user changed there.
export const getOpenAtLogin = makeIpcMethod({
  channel: IpcChannels.GET_OPEN_AT_LOGIN_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(DesktopOpenAtLoginStateSchema),
  handler: Effect.fn("desktop.ipc.openAtLogin.get")(function* () {
    return yield* DesktopLoginItem.reconcileOpenAtLogin();
  }),
});

export const setOpenAtLogin = makeIpcMethod({
  channel: IpcChannels.SET_OPEN_AT_LOGIN_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.NullOr(DesktopOpenAtLoginStateSchema),
  handler: DesktopLoginItem.setOpenAtLogin,
});

export const openLoginItemsSettings = makeIpcMethod({
  channel: IpcChannels.OPEN_LOGIN_ITEMS_SETTINGS_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.openAtLogin.openSettings")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return false;
    return yield* Effect.promise(() =>
      Electron.shell.openExternal(LOGIN_ITEMS_SETTINGS_URL).then(
        () => true,
        () => false,
      ),
    );
  }),
});
