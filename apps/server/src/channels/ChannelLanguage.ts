import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  firstAppleLanguage,
  languageFromLocale,
  type ResolvedChannelLanguage,
} from "./channelStrings.ts";

export class ChannelLanguage extends Context.Service<
  ChannelLanguage,
  {
    /** The language of T3's own messages in chats, read from settings on every call. */
    readonly current: Effect.Effect<ResolvedChannelLanguage>;
  }
>()("t3/channels/ChannelLanguage") {
  /** A fixed language, for tests. */
  static readonly layerFixed = (language: ResolvedChannelLanguage) =>
    Layer.succeed(ChannelLanguage, ChannelLanguage.of({ current: Effect.succeed(language) }));
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;

  const detect = Effect.gen(function* () {
    if (platform !== "darwin") {
      return languageFromLocale(Intl.DateTimeFormat().resolvedOptions().locale);
    }
    const output = yield* spawner
      .string(
        ChildProcess.make("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.timeout("2 seconds"),
        Effect.catchCause(() => Effect.succeed("")),
      );
    return languageFromLocale(firstAppleLanguage(output));
  });
  // The Mac's language is asked once per server lifetime; the setting is read on every call.
  const host = yield* Effect.cached(detect);

  return ChannelLanguage.of({
    current: Effect.gen(function* () {
      const setting = yield* settings.getSettings.pipe(
        Effect.map((value) => value.channelLanguage),
        Effect.orElseSucceed(() => "auto" as const),
      );
      return setting === "auto" ? yield* host : setting;
    }),
  });
});

export const layer = Layer.effect(ChannelLanguage, make);
