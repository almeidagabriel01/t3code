import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  receiveCodexAuthCallback,
  cancelCodexAuthCallback,
  CodexAuthCallbackError,
} from "../../app/CodexAuthCallback.ts";
import * as IntegrationCallback from "../../app/IntegrationCallback.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const Request = Schema.String.check(Schema.isMaxLength(16_384));

export const receiveProviderAuthCallback = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECEIVE_PROVIDER_AUTH_CALLBACK_CHANNEL,
  payload: Request,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.providerAuth.receive")(function* (authorizationUrl) {
    const shell = yield* ElectronShell.ElectronShell;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const context = yield* Effect.context<ElectronShell.ElectronShell>();
    const runPromise = Effect.runPromiseWith(context);
    const callbackUrl = yield* Effect.tryPromise({
      try: () =>
        receiveCodexAuthCallback(authorizationUrl, (url) => runPromise(shell.openExternal(url))),
      catch: () =>
        new CodexAuthCallbackError({
          detail:
            "Could not receive ChatGPT sign-in on this computer. Try again or paste the redirect URL.",
        }),
    });
    yield* desktopWindow.activate.pipe(Effect.ignore);
    return callbackUrl;
  }),
});

export const cancelProviderAuthCallback = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CANCEL_PROVIDER_AUTH_CALLBACK_CHANNEL,
  payload: Request,
  result: Schema.Void,
  handler: (authorizationUrl) =>
    Effect.try({
      try: () => cancelCodexAuthCallback(authorizationUrl),
      catch: () => new CodexAuthCallbackError({ detail: "Invalid ChatGPT sign-in request." }),
    }),
});

const IntegrationCallbackResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("received"), callbackUrl: Schema.String }),
  Schema.Struct({ status: Schema.Literals(["port-busy", "cancelled", "expired", "failed"]) }),
]);

export const receiveIntegrationCallback = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECEIVE_INTEGRATION_CALLBACK_CHANNEL,
  payload: Schema.Struct({ authorizationUrl: Request, redirectUri: Request }),
  result: IntegrationCallbackResult,
  handler: Effect.fn("desktop.ipc.integrations.receiveCallback")(function* (input) {
    const shell = yield* ElectronShell.ElectronShell;
    const windows = yield* ElectronWindow.ElectronWindow;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<ElectronShell.ElectronShell>());
    const result = yield* Effect.promise(() =>
      IntegrationCallback.receiveIntegrationCallback(input, (url) =>
        runPromise(shell.openExternal(url)),
      ),
    );
    const window = yield* windows.currentMainOrFirst;
    if (result.status === "received" && Option.isSome(window)) yield* windows.reveal(window.value);
    return result;
  }),
});

export const cancelIntegrationCallback = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CANCEL_INTEGRATION_CALLBACK_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: () => Effect.sync(IntegrationCallback.cancelIntegrationCallback),
});
