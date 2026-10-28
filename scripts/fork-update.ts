#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - sequential git/vp/macOS commands; plain node keeps it readable.
// @effect-diagnostics globalConsole:off - CLI output for a human.
/**
 * Merges upstream/main into main, builds the desktop DMG and optionally pushes and installs it.
 * Exit codes: 0 ok, 1 failed, 2 merge conflicts (merge aborted, repo left clean).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface ForkUpdateOptions {
  readonly dryRun: boolean;
  readonly push: boolean;
  readonly install: boolean;
  readonly rebuild: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): ForkUpdateOptions {
  const flags = new Set(argv);
  for (const flag of flags) {
    if (!["--dry-run", "--push", "--install", "--rebuild"].includes(flag)) {
      throw new Error(`Unknown option '${flag}'. Use --dry-run, --push, --install, --rebuild.`);
    }
  }
  return {
    dryRun: flags.has("--dry-run"),
    push: flags.has("--push"),
    install: flags.has("--install"),
    rebuild: flags.has("--rebuild"),
  };
}

/** Reads the output of `git rev-list --count`. */
export function parseCount(stdout: string): number {
  const count = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(count) || count < 0) throw new Error(`Unexpected git count '${stdout}'`);
  return count;
}

/** Reads the output of `git diff --name-only --diff-filter=U`. */
export function parseConflictFiles(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Newest `*-<arch>.dmg` among the release folder entries. */
export function findDmg(
  entries: ReadonlyArray<{ readonly name: string; readonly mtimeMs: number }>,
  arch: string,
): string | null {
  const matches = entries
    .filter((entry) => entry.name.endsWith(`-${arch}.dmg`))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.name ?? null;
}

class Stop extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

const log = (message: string) => console.log(`[fork-update] ${message}`);

// The fork must never bake in the official update feed.
const buildEnv = { ...process.env };
delete buildEnv.T3CODE_DESKTOP_UPDATE_REPOSITORY;
delete buildEnv.GITHUB_REPOSITORY;

function capture(command: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const git = (...args: ReadonlyArray<string>) => capture("git", args);

function mustRun(description: string, command: string, args: ReadonlyArray<string>) {
  log(description);
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", env: buildEnv });
  if (result.status !== 0) throw new Stop(`${description} failed (exit ${result.status ?? "?"}).`);
}

function mustGit(description: string, ...args: ReadonlyArray<string>) {
  const result = git(...args);
  if (result.status !== 0) throw new Stop(`${description}: ${result.stderr.trim()}`);
  return result.stdout;
}

// The app quits, which also ends this process and any terminal hosting it, so install runs detached.
const INSTALL_SCRIPT = `
APP="/Applications/T3 Code.app"
running() { [ "$(osascript -e 'application "T3 Code" is running')" = true ]; }
if running; then osascript -e 'tell application "T3 Code" to quit'; fi
i=0; while running && [ "$i" -lt 30 ]; do sleep 1; i=$((i+1)); done
if running; then echo "T3 Code did not quit; aborting install."; exit 1; fi
MNT=$(hdiutil attach -nobrowse -readonly "$1" | awk -F'\\t' '/\\/Volumes\\//{print $NF}' | tail -1)
SRC=$(ls -d "$MNT"/*.app | head -1)
rm -r "$APP" && ditto "$SRC" "$APP"
hdiutil detach "$MNT" -quiet
xattr -dr com.apple.quarantine "$APP"
open -a "T3 Code"
echo "Installed $1"
`;

function installDmg(dmgPath: string) {
  const logPath = NodePath.join(NodeOS.tmpdir(), "t3code-fork-install.log");
  const out = NodeFS.openSync(logPath, "a");
  const child = NodeChildProcess.spawn("/bin/sh", ["-c", INSTALL_SCRIPT, "sh", dmgPath], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  log(`Installer continues after T3 Code quits (log: ${logPath}). It reopens the app when done.`);
}

function run(options: ForkUpdateOptions) {
  log("Checking preconditions");
  const branch = mustGit("Cannot read branch", "rev-parse", "--abbrev-ref", "HEAD").trim();
  if (branch !== "main") throw new Stop(`Expected branch main, found '${branch}'.`);
  if (
    mustGit("Cannot read status", "status", "--porcelain", "--untracked-files=no").trim() !== ""
  ) {
    throw new Stop("Worktree has uncommitted changes. Commit or stash them first.");
  }
  const remotes = mustGit("Cannot list remotes", "remote").split("\n");
  for (const remote of ["origin", "upstream"]) {
    if (!remotes.includes(remote)) throw new Stop(`Remote '${remote}' is missing.`);
  }

  log("Fetching upstream and origin");
  mustGit("git fetch upstream failed", "fetch", "upstream", "--tags");
  mustGit("git fetch origin failed", "fetch", "origin");
  const behind = parseCount(mustGit("Cannot count", "rev-list", "--count", "main..upstream/main"));
  log(`${behind} new upstream commit(s)`);

  if (options.dryRun) {
    const predict = git("merge-tree", "--write-tree", "--name-only", "main", "upstream/main");
    log(
      behind === 0
        ? "Dry run: nothing to merge."
        : `Dry run: merge would ${predict.status === 0 ? "apply cleanly" : "conflict"}.`,
    );
    log(
      `Dry run: would ${[
        behind > 0 ? "merge upstream/main" : null,
        "vp i",
        "build the DMG",
        options.push ? "push origin main" : null,
        options.install ? "install into /Applications" : null,
      ]
        .filter(Boolean)
        .join(", ")}.`,
    );
    return;
  }

  if (behind === 0 && !options.rebuild) {
    log("Already up to date");
    return;
  }

  if (behind > 0) {
    log("Merging upstream/main into main");
    if (git("merge", "--no-edit", "upstream/main").status !== 0) {
      const files = parseConflictFiles(git("diff", "--name-only", "--diff-filter=U").stdout);
      git("merge", "--abort");
      if (files.length === 0) throw new Stop("Merge failed; it was aborted. Repo is clean.");
      console.error(`Conflicting files:\n${files.map((file) => `  ${file}`).join("\n")}`);
      throw new Stop(
        "Merge aborted, repo is clean. Resolve with an agent: use 'Resolve with agent' in Settings -> Fork updates.",
        2,
      );
    }
  }

  const hostArch = capture("uname", ["-m"]).stdout.trim();
  const arch = hostArch === "arm64" ? "arm64" : hostArch === "x86_64" ? "x64" : null;
  if (arch === null) throw new Stop(`Unsupported architecture ${hostArch}.`);
  mustRun("Installing dependencies", "vp", ["i"]);
  mustRun(`Building the ${arch} DMG (the merge stays local if this fails)`, "vp", [
    "run",
    `dist:desktop:dmg:${arch}`,
  ]);

  if (options.push) mustRun("Pushing origin main", "git", ["push", "origin", "main"]);

  const entries = NodeFS.readdirSync("release").map((name) => ({
    name,
    mtimeMs: NodeFS.statSync(NodePath.join("release", name)).mtimeMs,
  }));
  const dmg = findDmg(entries, arch);
  if (dmg === null) throw new Stop(`No *-${arch}.dmg found in release/.`);
  const dmgPath = NodePath.join(process.cwd(), "release", dmg);
  log(`Built ${dmgPath}`);

  if (options.install) installDmg(dmgPath);
  else log("Done. Re-run with --install to replace /Applications/T3 Code.app.");
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof Stop) {
      console.error(`[fork-update] ${error.message}`);
      process.exit(error.code);
    }
    console.error(error);
    process.exit(1);
  }
}
