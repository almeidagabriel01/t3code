// @effect-diagnostics nodeBuiltinImport:off
/**
 * The `t3 heavy hook` entry in the user's Claude Code settings, so sessions T3 did not start
 * queue heavy Bash calls too. Every other key and hook in the file is left as it was.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HeavyQueueError } from "@t3tools/contracts";

/** The `sh` entry the installed hook runs, beside the queue file. */
export const HOOK_SCRIPT = "t3-heavy-hook.sh";
const OURS = new RegExp(String.raw`\sheavy hook(\s|$)|${HOOK_SCRIPT.replaceAll(".", "\\.")}`);
/** Seconds Claude Code gives the hook; it answers in well under one. */
const HOOK_TIMEOUT_S = 10;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const claudeSettingsPath = (environment: NodeJS.ProcessEnv = process.env) =>
  NodePath.join(
    environment.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude"),
    "settings.json",
  );

const isOurs = (hook: unknown) =>
  isRecord(hook) && typeof hook.command === "string" && OURS.test(hook.command);

export const hasHeavyHook = (settings: Json) => {
  const groups = isRecord(settings.hooks) ? settings.hooks.PreToolUse : undefined;
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) => isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isOurs),
    )
  );
};

/** Settings with our hook removed, then added back once when `install`; idempotent either way. */
export const withHeavyHook = (settings: Json, command: string, install: boolean): Json => {
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const kept = groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurs)) {
      return [group];
    }
    const rest = group.hooks.filter((hook) => !isOurs(hook));
    return rest.length === 0 ? [] : [{ ...group, hooks: rest }];
  });
  const next = install
    ? [...kept, { matcher: "Bash", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }]
    : kept;
  const { PreToolUse: _previous, ...otherEvents } = hooks;
  const nextHooks = next.length === 0 ? otherEvents : { ...otherEvents, PreToolUse: next };
  const { hooks: _hooks, ...rest } = settings;
  // An empty `hooks` object means nothing, so removing the last hook drops it.
  return Object.keys(nextHooks).length === 0 ? rest : { ...rest, hooks: nextHooks };
};

/** Absent reads as empty; a file that is not a JSON object throws, so it is never overwritten. */
const readSettings = (path: string): Json => {
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
};

/**
 * The checkout root when `entry` is T3's own server entry in a git checkout (`vp run dev`,
 * `dev:desktop`, a source `bin.ts`); undefined for an installed T3 (app bundle, npm package, binary).
 */
const sourceCheckout = (entry: string | undefined) => {
  if (entry === undefined) return undefined;
  const root = /^(.*)[\\/]apps[\\/]server[\\/](?:src[\\/]bin\.ts|dist[\\/]bin\.mjs)$/.exec(
    NodePath.resolve(entry),
  )?.[1];
  return root !== undefined && NodeFS.existsSync(NodePath.join(root, ".git")) ? root : undefined;
};

/**
 * The only writer of hook state. A source run writes only inside its own checkout: the machine's
 * Claude sessions would otherwise run that checkout's code, and pass every call once it is deleted.
 */
const writeAtomic = (path: string, text: string, entry: string | undefined, mode?: number) => {
  const checkout = sourceCheckout(entry);
  if (checkout !== undefined) {
    const inside = NodePath.relative(checkout, NodePath.resolve(path));
    if (inside.split(NodePath.sep)[0] === ".." || NodePath.isAbsolute(inside)) {
      throw new HeavyQueueError({
        reason: "not-allowed",
        message: `T3 running from ${checkout} does not write ${path}; the installed T3 owns it.`,
      });
    }
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, text, mode === undefined ? undefined : { mode });
  NodeFS.renameSync(temp, path);
};

export const readHeavyHookInstalled = (path: string) => {
  try {
    return hasHeavyHook(readSettings(path));
  } catch {
    return false;
  }
};

/** Rewritten on install and at startup, so it always names the current T3 executable. */
export const writeHookScript = (
  path: string,
  script: string,
  entry: string | undefined = process.argv[1],
) => writeAtomic(path, script, entry, 0o755);

export const setHeavyHookInstalled = (
  path: string,
  command: string,
  install: boolean,
  entry: string | undefined = process.argv[1],
) => {
  const settings = readSettings(path);
  if (!install && !hasHeavyHook(settings)) return;
  // A dotfiles symlink stays a symlink: the rename lands on the file it points to.
  const target = NodeFS.existsSync(path) ? NodeFS.realpathSync(path) : path;
  writeAtomic(
    target,
    `${JSON.stringify(withHeavyHook(settings, command, install), null, 2)}\n`,
    entry,
  );
};
