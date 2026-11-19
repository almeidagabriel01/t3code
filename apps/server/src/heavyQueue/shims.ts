// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * A queue job runs its line as written with these first on PATH: one `sh` script per heavy
 * program, so each heavy call, in any script or git hook, picks its own machine through
 * `t3 heavy call`. A light call runs the real program without starting T3.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HEAVY_JOB_ENV, SHIM_FILTER, SHIMMED, shellQuote } from "./heavyHook.ts";

/** Marks a shim folder, so a shim and `withoutShims` skip every queue's, not only their own. */
const MARK = ".t3-heavy-shims";

const isShimDir = (dir: string) => dir !== "" && NodeFS.existsSync(NodePath.join(dir, MARK));

/** PATH with every shim folder taken out. */
export const withoutShims = (path: string | undefined) =>
  (path ?? "")
    .split(":")
    .filter((dir) => dir !== "" && !isShimDir(dir))
    .join(":");

/** The program a bare name runs on `path`, or the name itself when none is found. */
export const realProgram = (name: string, path: string | undefined) => {
  if (name.includes("/")) return name;
  for (const dir of withoutShims(path).split(":")) {
    const candidate = NodePath.join(dir, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      if (NodeFS.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return name;
};

const words = (names: ReadonlyArray<string>, suffix: boolean) =>
  names.flatMap((name) => (suffix ? [name, `${name}[:._-]*`] : [name])).join("|");

/** Light unless a word may make the call heavy; a formatter told `--stdin-filepath` is light. */
const FILTER = `h= f= i=
for a do
  case $a in
    --stdin-file-path*|--stdin-filepath*) i=1 ;;
    -*) ;;
    *) case \${a##*/} in
      ${words(SHIM_FILTER.formats, true)}) f=1 ;;
      ${words(SHIM_FILTER.scripts, true)}|${words(SHIM_FILTER.words, false)}) h=1 ;;
    esac ;;
  esac
done
[ -n "$h" ] || { [ -n "$f" ] && [ -z "$i" ]; } || here "$@"`;

/**
 * `call`: the shell words that start `t3 heavy call --queue-dir <dir>`. Only a call run here needs
 * the program on this Mac: Linux may have one this Mac lacks.
 */
const shimScript = (name: string, call: string) => `#!/bin/sh
# Written by T3 Code: in a heavy queue job, a heavy call goes through \`t3 heavy call\`.
here() {
  p= o=$IFS
  set -f
  IFS=:
  for d in $PATH; do [ -n "$d" ] && [ ! -e "$d/${MARK}" ] && p="\${p:+$p:}$d"; done
  IFS=$o
  set +f
  r=$(PATH=$p; command -v ${shellQuote(name)}) || { echo "${name}: command not found" >&2; exit 127; }
  exec "$r" "$@"
}
[ "\${${HEAVY_JOB_ENV}:-}" = 1 ] || here "$@"
${SHIM_FILTER.always.includes(name) ? "" : FILTER}
exec /usr/bin/env ${call} -- ${shellQuote(name)} "$@"
`;

/** A folder of shims nothing has started a job with for this long is removed. */
const UNUSED_MS = 7 * 86_400_000;

/**
 * Removes shim folders unused for `UNUSED_MS`, and the flat `<queue>/shims` files of the earlier
 * layout, scripts before their mark: a script without the mark beside it would find itself on PATH.
 */
const removeUnused = (root: string, keep: string, now: number) => {
  const unused = (folder: string) => {
    try {
      return now - NodeFS.statSync(NodePath.join(folder, MARK)).mtimeMs > UNUSED_MS;
    } catch {
      return false;
    }
  };
  // ponytail: a caller idle for a week that starts a job during this sweep can lose its folder mid-write; the next job rewrites it.
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    const folder = NodePath.join(root, entry.name);
    if (entry.isDirectory() && folder !== keep && unused(folder)) {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  }
  if (unused(root)) {
    for (const name of [...SHIMMED, MARK])
      NodeFS.rmSync(NodePath.join(root, name), { force: true });
  }
};

/**
 * Writes the shims into `<queue>/shims/<hash of call>` where they differ; jobs start concurrently.
 * Each CLI that calls back (the installed app, a worktree's dev server) keeps its own folder.
 */
export const ensureShims = (dir: string, call: string, now = Date.now()) => {
  const root = NodePath.join(dir, "shims");
  const shims = NodePath.join(
    root,
    NodeCrypto.createHash("sha256").update(call).digest("hex").slice(0, 12),
  );
  NodeFS.mkdirSync(shims, { recursive: true });
  const files: ReadonlyArray<readonly [string, string]> = [
    [MARK, ""],
    ...[...SHIMMED].map((name) => [name, shimScript(name, call)] as const),
  ];
  for (const [name, text] of files) {
    const path = NodePath.join(shims, name);
    try {
      if (NodeFS.readFileSync(path, "utf8") === text) continue;
    } catch {
      // Missing: written below.
    }
    const temp = `${path}.${process.pid}`;
    NodeFS.writeFileSync(temp, text, { mode: 0o755 });
    NodeFS.renameSync(temp, path);
  }
  // The mark's time is when this folder was last used; unchanged scripts keep theirs.
  NodeFS.utimesSync(NodePath.join(shims, MARK), now / 1000, now / 1000);
  removeUnused(root, shims, now);
  return shims;
};
