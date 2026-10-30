import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  ClaudeChromeConfigError,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigJsonPath,
  readClaudeChromeStatus,
  resolveClaudeHomePath,
  writeClaudeChromeDefault,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("locates .claude.json like the CLI: homePath, then env, then ~/.claude.json", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = { CLAUDE_CONFIG_DIR: "/tmp/claude-inherited" };
        const home = NodeOS.homedir();
        expect(yield* resolveClaudeConfigJsonPath({ homePath: "~/.claude-work" }, env)).toBe(
          path.join(home, ".claude-work", ".claude.json"),
        );
        expect(yield* resolveClaudeConfigJsonPath({ homePath: "" }, env)).toBe(
          path.resolve("/tmp/claude-inherited", ".claude.json"),
        );
        expect(yield* resolveClaudeConfigJsonPath({ homePath: "" }, {})).toBe(
          path.join(home, ".claude.json"),
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
  describe("Claude in Chrome config", () => {
    const instanceId = ProviderInstanceId.make("claude_chrome");
    const withHome = <A, E>(
      run: (input: {
        readonly dir: string;
        readonly file: string;
        readonly target: (
          launchArgs?: string,
          homePath?: string,
        ) => {
          readonly instanceId: typeof instanceId;
          readonly settings: { readonly homePath: string; readonly launchArgs: string };
          readonly environment: NodeJS.ProcessEnv;
        };
      }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
    ) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "claude-chrome-" });
        const home = path.join(dir, "home");
        return yield* run({
          dir,
          file: path.join(home, ".claude.json"),
          target: (launchArgs = "", homePath = home) => ({
            instanceId,
            settings: { homePath, launchArgs },
            environment: {},
          }),
        });
      }).pipe(Effect.scoped);

    const statusCases = [
      { name: "key true", text: '{"claudeInChromeDefaultEnabled":true}', enabled: true },
      { name: "key false", text: '{"claudeInChromeDefaultEnabled":false}', enabled: false },
      { name: "key absent", text: "{}", enabled: false },
      {
        name: "string true is not true",
        text: '{"claudeInChromeDefaultEnabled":"true"}',
        enabled: false,
      },
      { name: "malformed", text: "{not json", enabled: false },
      { name: "array", text: "[true]", enabled: false },
      { name: "null", text: "null", enabled: false },
      { name: "missing file", text: null, enabled: false },
    ];
    it.effect.each(statusCases)("reads $name without failing", ({ text, enabled }) =>
      withHome(({ dir, file, target }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if (text !== null) {
            yield* fs.makeDirectory(`${dir}/home`, { recursive: true });
            yield* fs.writeFileString(file, text);
          }
          expect(yield* readClaudeChromeStatus(target())).toEqual({
            instanceId,
            enabledByDefault: enabled,
            launchOverride: null,
            effective: enabled,
            extensionInstalled: null,
            pairedBrowser: null,
            sharedConfig: false,
          });
        }),
      ),
    );

    const overrideCases = [
      { args: "--chrome", enabled: false, override: "on", effective: true },
      { args: "--no-chrome", enabled: true, override: "off", effective: false },
      { args: "--model opus", enabled: true, override: null, effective: true },
    ] as const;
    it.effect.each(overrideCases)(
      "launch args $args decide what new sessions get",
      ({ args, enabled, override, effective }) =>
        withHome(({ dir, file, target }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(`${dir}/home`, { recursive: true });
            yield* fs.writeFileString(
              file,
              JSON.stringify({ claudeInChromeDefaultEnabled: enabled }),
            );
            const status = yield* readClaudeChromeStatus(target(args));
            expect(status).toMatchObject({
              enabledByDefault: enabled,
              launchOverride: override,
              effective,
            });
          }),
        ),
    );

    it.effect("reads the cached extension flag and paired browser", () =>
      withHome(({ dir, file, target }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${dir}/home`, { recursive: true });
          yield* fs.writeFileString(
            file,
            JSON.stringify({
              cachedChromeExtensionInstalled: true,
              chromeExtension: { pairedDeviceName: "Work laptop" },
            }),
          );
          expect(yield* readClaudeChromeStatus(target())).toMatchObject({
            extensionInstalled: true,
            pairedBrowser: "Work laptop",
          });
        }),
      ),
    );

    it.effect("flags the shared ~/.claude.json only without homePath and CLAUDE_CONFIG_DIR", () =>
      Effect.gen(function* () {
        const settings = { homePath: "", launchArgs: "" };
        const shared = yield* readClaudeChromeStatus({ instanceId, settings, environment: {} });
        const viaEnv = yield* readClaudeChromeStatus({
          instanceId,
          settings,
          environment: { CLAUDE_CONFIG_DIR: "/tmp/claude-chrome-nonexistent" },
        });
        expect(shared.sharedConfig).toBe(true);
        expect(viaEnv.sharedConfig).toBe(false);
      }),
    );

    it.effect("writes only its key, keeps every other key, and is idempotent", () =>
      withHome(({ dir, file, target }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${dir}/home`, { recursive: true });
          const original = {
            projects: { "/repo": { allowedTools: ["Bash"], nested: { deep: [1, 2] } } },
            userID: "abc",
            claudeInChromeDefaultEnabled: false,
            futureKey: null,
          };
          yield* fs.writeFileString(file, JSON.stringify(original));
          const status = yield* writeClaudeChromeDefault(target(), true);
          expect(status).toMatchObject({ enabledByDefault: true, effective: true });
          const expected = { ...original, claudeInChromeDefaultEnabled: true };
          expect(JSON.parse(yield* fs.readFileString(file))).toEqual(expected);
          const once = yield* fs.readFileString(file);
          yield* writeClaudeChromeDefault(target(), true);
          expect(yield* fs.readFileString(file)).toBe(once);
          expect((yield* writeClaudeChromeDefault(target(), false)).enabledByDefault).toBe(false);
          expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
            ...original,
            claudeInChromeDefaultEnabled: false,
          });
        }),
      ),
    );

    it.effect("creates a missing file and its directory", () =>
      withHome(({ file, target }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* writeClaudeChromeDefault(target(), true);
          expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
            claudeInChromeDefaultEnabled: true,
          });
        }),
      ),
    );

    it.effect.each(["{not json", "[1]", "null", '"text"'])("refuses to overwrite %s", (malformed) =>
      withHome(({ dir, file, target }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${dir}/home`, { recursive: true });
          yield* fs.writeFileString(file, malformed);
          const error = yield* writeClaudeChromeDefault(target(), true).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ClaudeChromeConfigError);
          expect(yield* fs.readFileString(file)).toBe(malformed);
        }),
      ),
    );
  });
});
