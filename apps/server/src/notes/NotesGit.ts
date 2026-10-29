import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { parseNote } from "./frontmatter.ts";

const IDENTITY_NAME = "T3 Code Notes";
const IDENTITY_EMAIL = "notes@t3code.local";

/** Commits the notes directory to its own repository two seconds after the last change. */
export class NotesGit extends Context.Service<
  NotesGit,
  {
    readonly changed: Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("t3/notes/NotesGit") {}

class NotesGitCommandError extends Schema.TaggedError<NotesGitCommandError>()(
  "NotesGitCommandError",
  { exitCode: Schema.NullOr(Schema.Number) },
) {}

const make = Effect.gen(function* () {
  const { notesDir } = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const signals = yield* Queue.sliding<void>(1);
  const lock = yield* Semaphore.make(1);
  let initialized = false;
  const run = (args: ReadonlyArray<string>) =>
    runner.run({
      command: "git",
      cwd: notesDir,
      args: ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      // ProcessRunner extends the inherited environment; undefined explicitly removes each override.
      env: {
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => /^GIT_/iu.test(key))
            .map((key) => [key, undefined]),
        ),
        EMAIL: undefined,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: IDENTITY_NAME,
        GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
        GIT_COMMITTER_NAME: IDENTITY_NAME,
        GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
      },
      timeout: "30 seconds",
      maxOutputBytes: 64 * 1024,
    });
  const checked = Effect.fn("NotesGit.checked")(function* (
    args: ReadonlyArray<string>,
    allowed: ReadonlyArray<number> = [0],
  ) {
    const result = yield* run(args);
    if (result.code === null || !allowed.includes(result.code))
      return yield* new NotesGitCommandError({ exitCode: result.code });
    return result;
  });
  const flushOnce = lock.withPermits(1)(
    Effect.gen(function* () {
      if (!initialized) {
        yield* checked(["init"]);
        initialized = true;
      }
      yield* checked(["add", "-A", "--", "."]);
      const diff = yield* checked(["diff", "--cached", "--quiet"], [0, 1]);
      if (diff.code !== 1) return;
      const changed = yield* checked(["diff", "--cached", "--name-only", "-z"]);
      const names = changed.stdout.split("\0").filter(Boolean);
      let message = names.length > 1 ? `notes: ${names.length} changes` : "notes: update notes";
      if (names.length === 1) {
        const name = names[0]!;
        const staged = yield* run(["show", `:${name}`]);
        const author =
          staged.code === 0
            ? yield* Effect.try(() => parseNote(staged.stdout).updatedBy).pipe(
                Effect.orElseSucceed(() => null),
              )
            : null;
        message = `notes: ${staged.code === 0 ? "update" : "delete"} ${name.replace(/[\r\n]/gu, " ")}${author ? ` (${author})` : ""}`;
      }
      yield* checked([
        "-c",
        `user.name=${IDENTITY_NAME}`,
        "-c",
        `user.email=${IDENTITY_EMAIL}`,
        "commit",
        "-m",
        message,
      ]);
    }),
  );
  // A failed commit leaves the tree dirty; signalling again retries it after the next quiet window.
  const flush = Effect.fn("NotesGit.flush")(function* () {
    yield* flushOnce.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Notes auto-commit pending", { reason: error._tag }).pipe(
          Effect.andThen(Queue.offer(signals, undefined)),
          Effect.asVoid,
        ),
      ),
    );
  });
  yield* Stream.fromQueue(signals).pipe(
    Stream.debounce("2 seconds"),
    Stream.runForEach(() => flush()),
    Effect.forkScoped,
  );
  return NotesGit.of({
    changed: Queue.offer(signals, undefined).pipe(Effect.asVoid),
    flush: flush(),
  });
});

export const layer = Layer.effect(NotesGit, make);
