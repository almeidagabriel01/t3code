// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  claudeSettingsPath,
  hasHeavyHook,
  HOOK_SCRIPT,
  readHeavyHookInstalled,
  setHeavyHookInstalled,
  withHeavyHook,
  writeHookScript,
} from "./claudeSettingsHook.ts";

const HOOK = "ELECTRON_RUN_AS_NODE=1 '/app/t3' heavy hook --queue-dir '/q'";
const ours = { matcher: "Bash", hooks: [{ type: "command", command: HOOK, timeout: 10 }] };
const lint = { matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh" }] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
/** A fake Claude home; the user's real settings file is never read or written. */
const tempSettings = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-home-"));
  dirs.push(dir);
  return NodePath.join(dir, "settings.json");
};

describe("the heavy hook in Claude Code settings", () => {
  it("adds itself once beside other hooks and keys, and removes only itself", () => {
    const settings = {
      model: "opus",
      futureKey: { nested: [1] },
      hooks: { PreToolUse: [lint], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    };
    const installed = withHeavyHook(settings, HOOK, true);
    expect(installed).toEqual({
      ...settings,
      hooks: { ...settings.hooks, PreToolUse: [lint, ours] },
    });
    expect(withHeavyHook(installed, HOOK, true)).toEqual(installed);
    expect(withHeavyHook(installed, HOOK, false)).toEqual(settings);
    expect(hasHeavyHook(installed)).toBe(true);
    expect(hasHeavyHook(settings)).toBe(false);
  });

  it("keeps a shared matcher group's other hooks, replaces an older command, and tidies empties", () => {
    const shared = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [lint.hooks[0], { type: "command", command: "/old/t3 heavy hook" }],
          },
          "not a group",
        ],
      },
    };
    expect(withHeavyHook(shared, HOOK, true).hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [lint.hooks[0]] }, "not a group", ours],
    });
    expect(withHeavyHook({ hooks: { PreToolUse: [ours] } }, HOOK, false)).toEqual({});
    expect(withHeavyHook({}, HOOK, false)).toEqual({});
    expect(withHeavyHook({ hooks: "odd" }, HOOK, true)).toEqual({ hooks: { PreToolUse: [ours] } });
  });

  it("writes through a temp home: creates the file, survives a symlink, never overwrites a broken one", () => {
    const path = tempSettings();
    expect(readHeavyHookInstalled(path)).toBe(false);
    setHeavyHookInstalled(path, HOOK, false);
    expect(NodeFS.existsSync(path)).toBe(false);
    setHeavyHookInstalled(path, HOOK, true);
    expect(readHeavyHookInstalled(path)).toBe(true);

    const real = NodePath.join(NodePath.dirname(path), "dotfiles.json");
    NodeFS.writeFileSync(real, JSON.stringify({ theme: "dark" }));
    NodeFS.rmSync(path);
    NodeFS.symlinkSync(real, path);
    setHeavyHookInstalled(path, HOOK, true);
    expect(NodeFS.lstatSync(path).isSymbolicLink()).toBe(true);
    expect(JSON.parse(NodeFS.readFileSync(real, "utf8"))).toMatchObject({ theme: "dark" });
    setHeavyHookInstalled(path, HOOK, false);
    expect(JSON.parse(NodeFS.readFileSync(real, "utf8"))).toEqual({ theme: "dark" });

    NodeFS.writeFileSync(real, "{ broken");
    expect(() => setHeavyHookInstalled(path, HOOK, true)).toThrow();
    expect(NodeFS.readFileSync(real, "utf8")).toBe("{ broken");
    expect(readHeavyHookInstalled(path)).toBe(false);
    NodeFS.writeFileSync(real, "[]");
    expect(() => setHeavyHookInstalled(path, HOOK, true)).toThrow("not a JSON object");
  });

  it("a T3 running from a checkout writes hook state only inside that checkout", () => {
    const home = NodePath.dirname(tempSettings());
    const checkout = NodePath.join(home, "worktrees", "t3");
    NodeFS.mkdirSync(checkout, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(checkout, ".git"), "gitdir: /repo/.git/worktrees/t3\n");
    const source = NodePath.join(checkout, "apps", "server", "src", "bin.ts");
    const installed =
      "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";
    const liveSettings = NodePath.join(home, ".claude-work", "settings.json");
    const liveScript = NodePath.join(home, ".t3", "heavy-queue", HOOK_SCRIPT);
    const linked = NodePath.join(checkout, ".t3", "claude", "settings.json");
    NodeFS.mkdirSync(NodePath.dirname(linked), { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(liveSettings), { recursive: true });
    NodeFS.writeFileSync(liveSettings, "{}");
    NodeFS.symlinkSync(liveSettings, linked);
    const rows = [
      { entry: source, file: "settings", path: liveSettings, refused: true },
      { entry: source, file: "script", path: liveScript, refused: true },
      { entry: source, file: "settings", path: linked, refused: true },
      { entry: source, file: "script", path: `${checkout}/.t3/heavy-queue-dev/${HOOK_SCRIPT}` },
      { entry: source, file: "settings", path: `${checkout}/.t3/claude/own.json` },
      { entry: installed, file: "script", path: liveScript },
      { entry: installed, file: "settings", path: liveSettings },
    ] as const;
    for (const row of rows) {
      const write = () =>
        row.file === "script"
          ? writeHookScript(row.path, "#!/bin/sh\n", row.entry)
          : setHeavyHookInstalled(row.path, HOOK, true, row.entry);
      if ("refused" in row) {
        expect(write, row.path).toThrow(/does not write/);
        expect(readHeavyHookInstalled(liveSettings), row.path).toBe(false);
      } else {
        write();
        if (row.file === "settings") expect(readHeavyHookInstalled(row.path), row.path).toBe(true);
        else expect(NodeFS.existsSync(row.path), row.path).toBe(true);
      }
    }
    expect(NodeFS.existsSync(liveScript)).toBe(true);
  });

  it("lives in CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/settings.json");
    expect(claudeSettingsPath({})).toBe(
      NodePath.join(NodeOS.homedir(), ".claude", "settings.json"),
    );
  });
});
