import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { DesktopTrayMenu } from "@t3tools/contracts";

type Listener = (...args: Array<never>) => void;
const native = vi.hoisted(() => {
  const state = {
    trays: [] as Array<{
      setTitle: ReturnType<typeof vi.fn>;
      setToolTip: ReturnType<typeof vi.fn>;
      setContextMenu: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
    }>,
    trayFails: false,
    menus: [] as Array<{
      template: ReadonlyArray<{ label?: string; type?: string; click?: () => void }>;
      listeners: Map<string, () => void>;
    }>,
    contents: null as unknown,
  };
  return state;
});

vi.mock("electron", () => {
  class Tray {
    setTitle = vi.fn();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    destroy = vi.fn();
    isDestroyed = vi.fn(() => false);
    constructor() {
      if (native.trayFails) throw new Error("no tray");
      native.trays.push(this);
    }
  }
  return {
    Tray,
    Menu: {
      buildFromTemplate: (template: never) => {
        const menu = { template, listeners: new Map<string, () => void>() };
        native.menus.push(menu);
        return { on: (event: string, listener: () => void) => menu.listeners.set(event, listener) };
      },
    },
    nativeImage: {
      createFromDataURL: () => ({ addRepresentation: vi.fn(), setTemplateImage: vi.fn() }),
    },
    webContents: { fromId: () => native.contents },
  };
});

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { installDesktopTray } from "./DesktopTray.ts";

const menu: DesktopTrayMenu = {
  attention: [
    { environmentId: "env", threadId: "a", title: "Approve me", project: "P", environment: null },
  ],
  running: [],
  pinned: [],
  attentionCount: 2,
};
const empty: DesktopTrayMenu = { attention: [], running: [], pinned: [], attentionCount: 0 };
const event = { sender: { id: 1 } };

interface FakeContents {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
  on: (event: string, listener: Listener) => void;
  once: (event: string, listener: Listener) => void;
  removeListener: (event: string) => void;
  emit: (event: string, ...args: Array<unknown>) => void;
}
const makeContents = (): FakeContents => {
  const listeners = new Map<string, Listener>();
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    on: (name, listener) => void listeners.set(name, listener),
    once: (name, listener) => void listeners.set(name, listener),
    removeListener: (name) => void listeners.delete(name),
    emit: (name, ...args) =>
      (listeners.get(name) as ((...a: Array<unknown>) => void) | undefined)?.(...args),
  };
};

const lastMenu = () => native.menus.at(-1)!;
const click = (label: string) => lastMenu().template.find((item) => item.label === label)!.click!();
const labels = () => lastMenu().template.map((item) => item.label ?? item.type);

const run = (
  platform: NodeJS.Platform,
  body: (input: {
    call: (value: unknown) => Promise<unknown>;
    activate: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  }) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const activate = vi.fn();
    const quit = vi.fn();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installDesktopTray();
        yield* body({
          call: async (value) => handlers.get("desktop:set-tray-menu")!(event, value),
          activate,
          quit,
        });
      }),
    ).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopWindow.DesktopWindow, {
            activate: Effect.sync(activate),
          } as unknown as DesktopWindow.DesktopWindow["Service"]),
          Layer.succeed(ElectronApp.ElectronApp, {
            name: Effect.succeed("T3 Code"),
            quit: Effect.sync(quit),
          } as unknown as ElectronApp.ElectronApp["Service"]),
          DesktopIpc.layerTest({
            handle: (channel, handler) => void handlers.set(channel, handler),
            removeHandler: (channel) => void handlers.delete(channel),
            on: vi.fn(),
            removeAllListeners: vi.fn(),
          }),
        ),
      ),
    );
  });

beforeEach(() => {
  native.trays.length = 0;
  native.menus.length = 0;
  native.trayFails = false;
  native.contents = makeContents();
  Object.defineProperty(process, "getSystemVersion", { value: () => "15.0.0", configurable: true });
});

it.effect("creates the tray from a published menu, badges it, and removes it on null", () =>
  run("darwin", ({ call }) =>
    Effect.promise(async () => {
      await call(menu);
      await call({ ...menu, attentionCount: 3 });
      expect(native.trays).toHaveLength(1);
      const [tray] = native.trays;
      expect(tray!.setTitle).toHaveBeenLastCalledWith(" 3");
      expect(tray!.setContextMenu).toHaveBeenCalledTimes(3);
      expect(labels()).toEqual([
        "Needs you",
        "Approve me",
        "separator",
        "New thread",
        "Open T3 Code",
        "separator",
        "Quit T3 Code",
      ]);

      await call({ ...menu, attentionCount: 0 });
      expect(tray!.setTitle).toHaveBeenLastCalledWith("");

      await call(null);
      expect(tray!.destroy).toHaveBeenCalledOnce();
      await call(menu);
      expect(native.trays).toHaveLength(2);
      expect(native.trays[1]!.setContextMenu).toHaveBeenCalled();
    }),
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(native.trays.at(-1)!.destroy).toHaveBeenCalledOnce();
      }),
    ),
  ),
);

it.effect("does nothing off macOS and validates the payload", () =>
  Effect.gen(function* () {
    yield* run("linux", ({ call }) => Effect.promise(() => call(menu).then(() => undefined)));
    expect(native.trays).toHaveLength(0);
    yield* run("darwin", ({ call }) =>
      Effect.promise(async () => {
        await expect(call({ ...menu, attentionCount: -1 })).rejects.toBeDefined();
        await expect(call({ attention: [] })).rejects.toBeDefined();
        expect(native.trays).toHaveLength(0);
      }),
    );
  }),
);

it.effect("keeps running when the tray cannot be created", () =>
  run("darwin", ({ call }) =>
    Effect.promise(async () => {
      native.trayFails = true;
      await call(menu);
      expect(native.trays).toHaveLength(0);
    }),
  ),
);

it.effect("draws headers as disabled rows before macOS 14", () =>
  run("darwin", ({ call }) =>
    Effect.promise(async () => {
      Object.defineProperty(process, "getSystemVersion", {
        value: () => "13.6.0",
        configurable: true,
      });
      await call(menu);
      expect(lastMenu().template[0]).toMatchObject({ label: "Needs you", enabled: false });
    }),
  ),
);

it.effect("rows activate the window and hand the action to the listening renderer", () =>
  run("darwin", ({ call, activate, quit }) =>
    Effect.promise(async () => {
      const contents = native.contents as FakeContents;
      await call(menu);

      const sent = new Promise<void>((resolve) =>
        contents.send.mockImplementationOnce(() => resolve()),
      );
      click("New thread");
      await sent;
      expect(activate).toHaveBeenCalledOnce();
      expect(contents.send).toHaveBeenLastCalledWith("desktop:menu-action", "tray.new-thread");

      const opened = new Promise<void>((resolve) =>
        contents.send.mockImplementationOnce(() => resolve()),
      );
      click("Approve me");
      await opened;
      expect(contents.send).toHaveBeenLastCalledWith(
        "desktop:menu-action",
        `tray.open-thread:${JSON.stringify({ environmentId: "env", threadId: "a" })}`,
      );

      const quitting = new Promise<void>((resolve) => quit.mockImplementationOnce(() => resolve()));
      click("Open T3 Code");
      click("Quit T3 Code");
      await quitting;
      expect(activate).toHaveBeenCalledTimes(3);
    }),
  ),
);

it.effect("holds a pick for a recreated window and drops stale rows when the renderer goes", () =>
  run("darwin", ({ call, activate }) =>
    Effect.promise(async () => {
      const first = native.contents as FakeContents;
      await call(menu);
      first.emit("destroyed");
      expect(labels()).toEqual([
        "Nothing running",
        "separator",
        "New thread",
        "Open T3 Code",
        "separator",
        "Quit T3 Code",
      ]);
      expect(native.trays[0]!.setTitle).toHaveBeenLastCalledWith("");

      const activated = new Promise<void>((resolve) =>
        activate.mockImplementationOnce(() => resolve()),
      );
      click("New thread");
      await activated;
      await Promise.resolve();
      await Promise.resolve();
      expect(first.send).not.toHaveBeenCalled();

      const second = makeContents();
      native.contents = second;
      await call(menu);
      expect(second.send).toHaveBeenCalledWith("desktop:menu-action", "tray.new-thread");
      await call(menu);
      expect(second.send).toHaveBeenCalledOnce();

      second.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
      expect(labels()[0]).toBe("Needs you");
      second.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      expect(labels()[0]).toBe("Needs you");
      second.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      expect(labels()[0]).toBe("Nothing running");
    }),
  ),
);

it.effect("does not replace the menu while it is open", () =>
  run("darwin", ({ call }) =>
    Effect.promise(async () => {
      await call(empty);
      const open = lastMenu();
      const count = native.menus.length;
      open.listeners.get("menu-will-show")!();
      await call(menu);
      expect(native.menus).toHaveLength(count);
      open.listeners.get("menu-will-close")!();
      expect(native.menus).toHaveLength(count + 1);
    }),
  ),
);
