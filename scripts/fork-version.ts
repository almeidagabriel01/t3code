#!/usr/bin/env node
/**
 * Fork versions read `<upstream version>-fork.<n>`: the number in front is the upstream release the
 * fork is based on, `fork.n` counts the fork's own releases. With no flags this bumps `n`;
 * `--base X.Y.Z` moves to a newer upstream base and restarts at `fork.1`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { compareSemverVersions } from "@t3tools/shared/semver";

import { updateReleasePackageVersions } from "./update-release-package-versions.ts";

const decodeDesktopManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
const STABLE = /^\d+\.\d+\.\d+$/;
const FORK = /^(\d+\.\d+\.\d+)-fork\.(\d+)$/;

/** Next fork version. A plain `X.Y.Z` current version counts as its own base. */
export function nextForkVersion(current: string, base?: string): string {
  const forked = FORK.exec(current);
  const currentBase = forked?.[1] ?? (STABLE.test(current) ? current : null);
  if (currentBase === null) {
    throw new Error(`Cannot bump '${current}': expected X.Y.Z or X.Y.Z-fork.N.`);
  }
  const currentCount = forked ? Number(forked[2]) : 0;
  if (base === undefined) return `${currentBase}-fork.${currentCount + 1}`;
  if (!STABLE.test(base)) throw new Error(`--base must be a stable X.Y.Z version, got '${base}'.`);
  const order = compareSemverVersions(base, currentBase);
  if (order < 0) throw new Error(`--base ${base} is older than the current base ${currentBase}.`);
  return order === 0 ? `${currentBase}-fork.${currentCount + 1}` : `${base}-fork.1`;
}

/** iOS only accepts numeric versions, so the mobile app carries the upstream base and EAS counts the builds. */
export function setMobileForkVersion(easJson: string, version: string): string {
  const eas = JSON.parse(easJson);
  eas.build.fork.env.T3CODE_MOBILE_VERSION = version.split("-")[0];
  return `${JSON.stringify(eas, null, 2)}\n`;
}

/** `--base X.Y.Z`, `--base=X.Y.Z` and `--dry-run`; anything else is a typo worth stopping on. */
export function parseArgs(argv: ReadonlyArray<string>) {
  let base: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--base") base = argv[++i] ?? "";
    else if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else throw new Error(`Unknown option '${arg}'. Use --base X.Y.Z, --dry-run.`);
    if (base === "") throw new Error("--base needs a version.");
  }
  return { base, dryRun };
}

export const bumpForkVersion = Effect.fn("bumpForkVersion")(function* (
  rootDir: string,
  argv: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { base, dryRun } = parseArgs(argv);
  const desktopManifest = path.join(rootDir, "apps/desktop/package.json");
  const { version: current } = yield* decodeDesktopManifest(
    yield* fs.readFileString(desktopManifest),
  );
  const next = nextForkVersion(current, base);
  if (!dryRun) {
    yield* updateReleasePackageVersions(next, { rootDir });
    const easPath = path.join(rootDir, "apps/mobile/eas.json");
    yield* fs.writeFileString(
      easPath,
      setMobileForkVersion(yield* fs.readFileString(easPath), next),
    );
  }
  return { current, next, dryRun };
});

const main = bumpForkVersion(process.cwd(), process.argv.slice(2)).pipe(
  Effect.tap(({ current, next, dryRun }) =>
    Console.log(`${current} -> ${next}${dryRun ? " (dry run)" : ""}`),
  ),
);

if (import.meta.main) {
  main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
