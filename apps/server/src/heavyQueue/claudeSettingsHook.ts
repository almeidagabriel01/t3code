// @effect-diagnostics nodeBuiltinImport:off
/**
 * The `t3 heavy hook` entry in the user's Claude Code settings, so sessions T3 did not start
 * queue heavy Bash calls too. Every other key and hook in the file is left as it was.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

export const readHeavyHookInstalled = (path: string) => {
  try {
    return hasHeavyHook(readSettings(path));
  } catch {
    return false;
  }
};

/** Rewritten on install and at startup, so it always names the current T3 executable. */
export const writeHookScript = (path: string, script: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, script, { mode: 0o755 });
  NodeFS.renameSync(temp, path);
};

export const setHeavyHookInstalled = (path: string, command: string, install: boolean) => {
  const settings = readSettings(path);
  if (!install && !hasHeavyHook(settings)) return;
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  // A dotfiles symlink stays a symlink: the rename lands on the file it points to.
  const target = NodeFS.existsSync(path) ? NodeFS.realpathSync(path) : path;
  const temp = `${target}.${process.pid}.tmp`;
  NodeFS.writeFileSync(
    temp,
    `${JSON.stringify(withHeavyHook(settings, command, install), null, 2)}\n`,
  );
  NodeFS.renameSync(temp, target);
};
