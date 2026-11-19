// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - A real loopback listener, hit like a browser.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeNet from "node:net";
import { vi } from "vite-plus/test";
import type * as Electron from "electron";

vi.mock("electron", () => ({}));

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { cancelIntegrationCallback, receiveIntegrationCallback } from "./providerAuth.ts";

const freePort = Effect.promise(async () => {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
});

it.live("hands the received callback to the renderer and brings the window forward", () =>
  Effect.gen(function* () {
    const redirectUri = `http://127.0.0.1:${yield* freePort}/integrations/callback`;
    const window = {} as Electron.BrowserWindow;
    const revealed: Electron.BrowserWindow[] = [];
    const result = yield* receiveIntegrationCallback
      .handler({ authorizationUrl: "https://auth.example.com/authorize?state=s", redirectUri })
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronShell.ElectronShell)({
              openExternal: () =>
                Effect.promise(() => fetch(`${redirectUri}?code=c&state=s`)).pipe(Effect.as(true)),
            }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              currentMainOrFirst: Effect.succeedSome(window),
              reveal: (target) => Effect.sync(() => void revealed.push(target)),
            }),
          ),
        ),
      );
    assert.deepStrictEqual(result, {
      status: "received",
      callbackUrl: `${redirectUri}?code=c&state=s`,
    });
    assert.deepStrictEqual(revealed, [window]);
    yield* cancelIntegrationCallback.handler(undefined);
  }),
);
