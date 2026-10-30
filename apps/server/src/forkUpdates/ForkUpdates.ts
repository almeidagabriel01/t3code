import type { ForkUpdateStatus, ForkUpdateStatusInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";
import { inferChannel, latestChannelTag } from "@t3tools/shared/forkUpdateTags";

import * as ProcessRunner from "../processRunner.ts";

export class ForkUpdates extends Context.Service<
  ForkUpdates,
  {
    /** Read-only git inspection (plus `git fetch upstream --tags`) of the latest tag of the chosen channel. Never touches the worktree. Failures yield `available: false`. */
    readonly status: (input: ForkUpdateStatusInput) => Effect.Effect<ForkUpdateStatus>;
  }
>()("t3/forkUpdates/ForkUpdates") {}

const DEFAULT_FORK_PATH = "~/DEV/Pessoal/t3code";
const FETCH_TIMEOUT = Duration.seconds(60);
const GIT_TIMEOUT = Duration.seconds(15);

export const resolveForkPath = (input: string, home: string): string => {
  const raw = input.trim() === "" ? DEFAULT_FORK_PATH : input.trim();
  return raw === "~" ? home : raw.replace(/^~\//, `${home}/`);
};

/** `git merge-tree --write-tree --name-only` prints the tree id, then the conflicted paths, then a blank line. */
export const parseMergeTreeConflicts = (stdout: string): ReadonlyArray<string> => {
  const [, ...rest] = stdout.split("\n");
  const end = rest.indexOf("");
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.length > 0);
};

const make = Effect.gen(function* ForkUpdatesMake() {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const git = (cwd: string, args: ReadonlyArray<string>, timeout = GIT_TIMEOUT) =>
    processRunner
      .run({ command: "git", args, cwd, timeout, maxOutputBytes: 1024 * 1024 })
      .pipe(Effect.orElseSucceed(() => null));

  const out = (cwd: string, args: ReadonlyArray<string>) =>
    git(cwd, args).pipe(
      Effect.map((result) => (result?.code === 0 ? result.stdout.trim() || null : null)),
    );

  const status = Effect.fn("ForkUpdates.status")(function* (input: ForkUpdateStatusInput) {
    const path = resolveForkPath(input.path, NodeOS.homedir());
    const unavailable: ForkUpdateStatus = {
      available: false,
      path,
      channel: input.channel === "nightly" ? "nightly" : "stable",
      headSha: null,
      headSubject: null,
      headTag: null,
      upstreamSha: null,
      upstreamTag: null,
      behind: 0,
      wouldConflict: null,
      conflictFiles: [],
    };
    const upstreamUrl = yield* out(path, ["remote", "get-url", "upstream"]);
    if (upstreamUrl === null) return unavailable;

    // Offline fetches fail; the refs already on disk still answer.
    yield* git(path, ["fetch", "upstream", "--tags", "--quiet"], FETCH_TIMEOUT);

    const desktopPackage = yield* out(path, ["show", "main:apps/desktop/package.json"]);
    const desktopVersion = (() => {
      try {
        return String(JSON.parse(desktopPackage ?? "{}").version ?? "");
      } catch {
        return "";
      }
    })();
    const channel = input.channel === "auto" ? inferChannel(desktopVersion) : input.channel;
    const allTags = (yield* out(path, ["tag", "--list", "v*"]))?.split("\n") ?? [];
    const mergedTags =
      (yield* out(path, ["tag", "--list", "v*", "--merged", "main"]))?.split("\n") ?? [];
    const upstreamTag = latestChannelTag(allTags, channel);
    const headTag = latestChannelTag(mergedTags, channel);

    const head = yield* out(path, ["log", "-1", "--format=%H%x09%s", "main"]);
    if (head === null) return { ...unavailable, channel };
    const [headSha = null, headSubject = null] = head.split("\t");
    if (upstreamTag === null) {
      return { ...unavailable, available: true, channel, headSha, headSubject, headTag };
    }
    const behindText = yield* out(path, ["rev-list", "--count", `main..${upstreamTag}`]);
    if (behindText === null) return { ...unavailable, channel };
    const behind = Number.parseInt(behindText, 10) || 0;

    let wouldConflict: boolean | null = null;
    let conflictFiles: ReadonlyArray<string> = [];
    if (behind > 0) {
      const merge = yield* git(path, [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "main",
        upstreamTag,
      ]);
      if (merge?.code === 0) wouldConflict = false;
      else if (merge?.code === 1) {
        wouldConflict = true;
        conflictFiles = parseMergeTreeConflicts(merge.stdout);
      }
    }

    return {
      available: true,
      path,
      channel,
      headSha,
      headSubject,
      headTag,
      upstreamSha: yield* out(path, ["rev-parse", `${upstreamTag}^{commit}`]),
      upstreamTag,
      behind,
      wouldConflict,
      conflictFiles,
    } satisfies ForkUpdateStatus;
  });

  return ForkUpdates.of({ status });
});

export const layer = Layer.effect(ForkUpdates, make);
