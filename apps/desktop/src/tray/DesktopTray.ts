import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DESKTOP_TRAY_NEW_THREAD_ACTION,
  DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX,
  type DesktopTrayMenu,
} from "@t3tools/contracts";

import * as ElectronApp from "../electron/ElectronApp.ts";
import { MENU_ACTION_CHANNEL, SET_TRAY_MENU_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./trayIcon.ts";
import { trayMenuTemplate } from "./trayMenu.ts";
import { TrayMenuPayload } from "./trayMenuPayload.ts";
import { createTrayMenuGate } from "./trayMenuGate.ts";

const EMPTY_MENU: DesktopTrayMenu = { attention: [], running: [], pinned: [], attentionCount: 0 };

const macOSMajor = () => Number.parseInt(process.getSystemVersion().split(".")[0] ?? "0", 10);

/** The macOS menu-bar icon listing the threads the renderer reports; the renderer can also remove it. */
export const installDesktopTray = Effect.fn("desktop.tray.install")(function* () {
  const platform = yield* HostProcess.Platform;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const appName = yield* electronApp.name;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const run = <E>(effect: Effect.Effect<void, E>, action: string) =>
    void runPromise(
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("tray action failed", { action, cause })),
      ),
    );

  // An action waits for a renderer that has published a menu, which it does only after it
  // subscribes; a window that macOS closed is recreated and answers once it is up.
  let listening: Electron.WebContents | null = null;
  let pending: string | null = null;
  const deliver = () => {
    if (pending === null || listening === null || listening.isDestroyed()) return;
    listening.send(MENU_ACTION_CHANNEL, pending);
    pending = null;
  };
  const pick = (action: string, name: string) =>
    run(
      desktopWindow.activate.pipe(
        Effect.andThen(
          Effect.sync(() => {
            pending = action;
            deliver();
          }),
        ),
      ),
      name,
    );
  const actions = {
    openApp: () => run(desktopWindow.activate, "open-app"),
    newThread: () => pick(DESKTOP_TRAY_NEW_THREAD_ACTION, "new-thread"),
    openThread: (thread: { environmentId: string; threadId: string }) =>
      pick(
        DESKTOP_TRAY_OPEN_THREAD_ACTION_PREFIX +
          JSON.stringify({ environmentId: thread.environmentId, threadId: thread.threadId }),
        "open-thread",
      ),
    quit: () => run(electronApp.quit, "quit"),
  };

  let tray: Electron.Tray | null = null;
  let attentionCount = 0;
  const syncTitle = () => {
    tray?.setTitle(attentionCount > 0 ? ` ${attentionCount}` : "");
  };
  const gate = createTrayMenuGate(EMPTY_MENU, (menu) => {
    if (tray === null || tray.isDestroyed()) return;
    const built = Electron.Menu.buildFromTemplate(
      trayMenuTemplate({ menu, appName, nativeHeaders: macOSMajor() >= 14, actions }),
    );
    built.on("menu-will-show", gate.opened);
    built.on("menu-will-close", gate.closed);
    tray.setContextMenu(built);
  });
  const show = () => {
    if (tray !== null) return;
    try {
      const image = Electron.nativeImage.createFromDataURL(TRAY_ICON_1X);
      image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
      image.setTemplateImage(true);
      tray = new Electron.Tray(image);
      tray.setToolTip(appName);
      gate.reapply();
    } catch (cause) {
      tray = null;
      run(Effect.logWarning("could not create tray", { cause: String(cause) }), "create");
    }
  };
  const hide = () => {
    if (tray !== null && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };
  yield* Effect.addFinalizer(() => Effect.sync(hide));

  // Rows go stale once their renderer reloads or is gone (macOS keeps running windowless).
  const listen = (contents: Electron.WebContents) => {
    if (listening === contents) return deliver();
    listening = contents;
    const forget = () => {
      contents.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("destroyed", forget);
      if (listening !== contents) return;
      listening = null;
      attentionCount = 0;
      syncTitle();
      gate.update(EMPTY_MENU);
    };
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) forget();
    };
    contents.on("did-start-navigation", onNavigation);
    contents.once("destroyed", forget);
    deliver();
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_TRAY_MENU_CHANNEL,
      payload: TrayMenuPayload,
      result: Schema.Void,
      handler: (menu, event) =>
        Effect.sync(() => {
          if (platform !== "darwin") return;
          if (menu === null) {
            hide();
            return;
          }
          show();
          attentionCount = menu.attentionCount;
          syncTitle();
          gate.update(menu);
          const sender =
            event === undefined ? undefined : Electron.webContents.fromId(event.sender.id);
          if (sender !== undefined && !sender.isDestroyed()) listen(sender);
        }),
    }),
  );
});
