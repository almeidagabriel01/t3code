// @effect-diagnostics nodeBuiltinImport:off
/**
 * A queue job runs its line as written with these first on PATH: one `sh` script per heavy
 * program, so each heavy call, in any script or git hook, picks its own machine through
 * `t3 heavy call`. A light call runs the real program without starting T3.
 */
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

/** Writes the shims into `<queue>/shims` where they differ; jobs start concurrently. */
export const ensureShims = (dir: string, call: string) => {
  const shims = NodePath.join(dir, "shims");
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
  return shims;
};
