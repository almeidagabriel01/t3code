import { assert, it } from "@effect/vitest";
import type { ChannelLanguage as Setting } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelLanguage from "./ChannelLanguage.ts";

const harness = (input: { readonly output?: string; readonly fails?: boolean }) =>
  Effect.gen(function* () {
    const setting = yield* Ref.make<Setting>("auto");
    const spawns = yield* Ref.make(0);
    const layer = ChannelLanguage.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.get(setting).pipe(
              Effect.map((channelLanguage) => ({ channelLanguage }) as never),
            ),
          }),
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Ref.update(spawns, (count) => count + 1).pipe(
                Effect.andThen(
                  input.fails
                    ? Effect.die("no defaults")
                    : Effect.succeed(
                        ChildProcessSpawner.makeHandle({
                          pid: ChildProcessSpawner.ProcessId(1),
                          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                          isRunning: Effect.succeed(false),
                          kill: () => Effect.void,
                          unref: Effect.succeed(Effect.void),
                          stdin: Sink.drain,
                          stdout: Stream.encodeText(Stream.make(input.output ?? "")),
                          stderr: Stream.empty,
                          all: Stream.empty,
                          getInputFd: () => Sink.drain,
                          getOutputFd: () => Stream.empty,
                        }),
                      ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return { setting, spawns, layer };
  });

const portuguese = '(\n    "pt-BR",\n    "en-US"\n)';

it.effect("auto follows the Mac's first language and asks only once", () =>
  Effect.gen(function* () {
    const h = yield* harness({ output: portuguese });
    yield* Effect.gen(function* () {
      const { current } = yield* ChannelLanguage.ChannelLanguage;
      assert.equal(yield* current, "pt-BR");
      assert.equal(yield* current, "pt-BR");
      assert.equal(yield* Ref.get(h.spawns), 1);
      yield* Ref.set(h.setting, "en");
      assert.equal(yield* current, "en");
      yield* Ref.set(h.setting, "pt-BR");
      assert.equal(yield* current, "pt-BR");
      yield* Ref.set(h.setting, "auto");
      assert.equal(yield* current, "pt-BR");
    }).pipe(Effect.provide(h.layer));
  }),
);

const englishCases: ReadonlyArray<readonly [string, { output?: string; fails?: boolean }]> = [
  ["a non-Portuguese Mac", { output: '(\n    "en-US"\n)' }],
  ["an unreadable answer", { output: "" }],
  ["a failing command", { fails: true }],
];

it.effect.each(englishCases)("auto reads English for %s", ([, input]) =>
  Effect.gen(function* () {
    const h = yield* harness(input);
    const { current } = yield* ChannelLanguage.ChannelLanguage.pipe(Effect.provide(h.layer));
    assert.equal(yield* current, "en");
  }),
);
