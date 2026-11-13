// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_MACHINE_CONFIG } from "./runner.ts";
import {
  changedInputs,
  checkLinux,
  confirmed,
  remoteCommand,
  removeRunnerCopy,
  resolveRemoto,
  startLinuxRun,
  stopRemote,
  withProjectBins,
} from "./runnerExec.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-exec-"));
let scripts = 0;
/** An executable sh script standing in for `remoto` or `ssh`. */
const fake = (body: string) => {
  scripts += 1;
  const path = NodePath.join(dir, `fake-${scripts}`);
  NodeFS.writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
};
const M = "\\036remoto";

const runWith = (remoto: string, script = "vp test run", cwd = dir) => {
  const stdout: Buffer[] = [];
  let stderr = "";
  const phases: string[] = [];
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const run = startLinuxRun({
    remoto,
    program: "/bin/zsh",
    args: ["-c", script],
    cwd,
    root: dir,
    environment: process.env,
    machine: DEFAULT_MACHINE_CONFIG,
    macOnly: ["CaptureDevices.test.ts"],
    onProgress: (progress) => {
      phases.push(progress.phase ?? "");
      if (progress.running) started();
    },
    stdout: (chunk) => stdout.push(chunk),
    stderr: (text) => (stderr += text),
  });
  return {
    run,
    running,
    phases,
    out: () => Buffer.concat(stdout).toString("utf8"),
    err: () => stderr,
  };
};

describe("running on Linux through remoto", () => {
  it.each([
    ["/bin/zsh", ["-c", "vp test"], ["bash", "-c", "vp test"]],
    ["/opt/homebrew/bin/node", ["--test"], ["node", "--test"]],
    ["vp", ["test"], ["vp", "test"]],
    // Paths inside the checkout become relative to the folder it runs from there.
    [
      "vp",
      ["test", "run", "/w/repo/apps/web/src/a.test.ts"],
      ["vp", "test", "run", "src/a.test.ts"],
    ],
    ["vp", ["test", "--root=/w/repo/apps/web"], ["vp", "test", "--root=."]],
    ["vp", ["test", "--dir=/w/repo/packages/x"], ["vp", "test", "--dir=../../packages/x"]],
    ["vp", ["test", "/tmp/out.json", "--x=/tmp/y"], ["vp", "test", "/tmp/out.json", "--x=/tmp/y"]],
    ["/w/repo/node_modules/.bin/vitest", ["run"], ["../../node_modules/.bin/vitest", "run"]],
    ["/w/repo/apps/web/run.sh", [], ["./run.sh"]],
    ["./scripts/check.sh", [], ["./scripts/check.sh"]],
  ] as const)("%s %j runs there as %j", (program, args, expected) => {
    expect(remoteCommand(program, args, "/w/repo/apps/web", "/w/repo")).toEqual(expected);
  });

  it("passes output through, strips markers into progress and keeps the command's code", async () => {
    const remoto = fake(
      [
        `printf '${M} phase=syncing id=app-1a2b3c4d\\n' >&2`,
        `printf '${M} phase=installing\\n' >&2`,
        `printf '${M} phase=running pgid=42\\n' >&2`,
        // printf, not echo: sh's echo reads the pre-flight's own backslashes.
        `printf '%s\\n' "args:$*"`,
        "echo FAIL src/device/CaptureDevices.test.ts",
        "printf 'to-stderr\\npartial' >&2",
        `printf '${M} exit=3\\n' >&2`,
        "exit 3",
      ].join("\n"),
    );
    const { run, phases, out, err } = runWith(remoto);
    const result = await run.done;
    expect(result.outcome).toEqual({ kind: "finished", code: 3 });
    expect(result.progress).toMatchObject({ id: "app-1a2b3c4d", pgid: 42 });
    expect(result.platform).toEqual(["FAIL src/device/CaptureDevices.test.ts"]);
    expect(phases).toEqual(["syncing", "installing", "running", "running"]);
    expect(out()).toBe(
      `args:${withProjectBins(["bash", "-c", "vp test run"], dir, dir).join(" ")}\nFAIL src/device/CaptureDevices.test.ts\n`,
    );
    expect(err()).toBe("to-stderr\npartial");
  });

  it.each([
    ["/w", '"$PWD"', '"$PWD/node_modules/.bin:$PATH"'],
    [
      "/w/apps/web",
      '"${PWD%/*/*}"',
      '"$PWD/node_modules/.bin:${PWD%/*}/node_modules/.bin:${PWD%/*/*}/node_modules/.bin:$PATH"',
    ],
  ])("from %s, the copy is %s and project tools come from %s first", (cwd, copy, path) => {
    const wrapped = withProjectBins(["vp", "test"], cwd, "/w");
    expect([...wrapped.slice(0, 2), ...wrapped.slice(3)]).toEqual([
      "bash",
      "-c",
      "t3",
      "vp",
      "test",
    ]);
    expect(
      wrapped[2]!.startsWith(
        `export T3_COPY=${copy} PATH=${path}; command -v -- 'vp' >/dev/null 2>&1 || { printf '\\036remoto missing=%s\\n' 'vp' >&2; exit 127; }; `,
      ),
    ).toBe(true);
    expect(wrapped[2]!.endsWith('; exec "$@"')).toBe(true);
  });

  // Linux has no Mac home: the text's paths into the checkout point at its copy (`$T3_COPY`).
  it.each([
    ["cd /Users/me/wt/apps/server && vp test", `cd "$T3_COPY"'/apps/server' && vp test`],
    ["cd ~/wt/apps/server && vp test", `cd "$T3_COPY"'/apps/server' && vp test`],
    ["cd $HOME/wt && vp test", `cd "$T3_COPY" && vp test`],
    ['cd "${HOME}/wt/a b" && vp test', `cd "$T3_COPY"'/a b' && vp test`],
    [
      "vp test --root=/Users/me/wt/apps/web > /Users/me/wt/out.txt",
      `vp test '--root='"$T3_COPY"'/apps/web' > "$T3_COPY"'/out.txt'`,
    ],
    ["echo $(cat /Users/me/wt/list)", `echo $(cat "$T3_COPY"'/list')`],
    // Not the checkout, a quoted `~`, another home or variable: left as written.
    ["cd /Users/me/other && vp test", "cd /Users/me/other && vp test"],
    ["cd /Users/me/wt-2 && vp test", "cd /Users/me/wt-2 && vp test"],
    ["echo '~/wt' $WT/x ~other/wt", "echo '~/wt' $WT/x ~other/wt"],
  ])("sh -c %j runs there as %j", (text, expected) => {
    expect(
      remoteCommand("/bin/sh", ["-ec", text], "/Users/me/wt/apps/web", "/Users/me/wt", "/Users/me"),
    ).toEqual(["bash", "-ec", expected]);
  });

  it("an absolute cd into the checkout lands in its copy there", async () => {
    const web = NodePath.join(dir, "apps", "web");
    NodeFS.mkdirSync(NodePath.join(dir, "apps", "server"), { recursive: true });
    NodeFS.mkdirSync(web, { recursive: true });
    // Stands in for `remoto-rodar`, which runs the wrapper in the same folder of the copy.
    const { run, out } = runWith(fake('exec "$@"'), `cd ${dir}/apps/server && pwd -P`, web);
    await run.done;
    expect(out()).toBe(`${NodeFS.realpathSync(NodePath.join(dir, "apps", "server"))}\n`);
  });

  // Electron 44 fetches its binary on first use: two test workers raced on it in a fresh copy.
  it.each([
    ["no Electron", null, "", "ran\n", { kind: "finished", code: 0 }, null],
    ["Electron settled", "linux", "", "ran\n", { kind: "finished", code: 0 }, null],
    [
      "Electron with no path.txt",
      "fresh",
      "install\n",
      "ran\n",
      { kind: "finished", code: 0 },
      null,
    ],
    [
      "Electron missing its binary",
      "gone",
      "install\n",
      "ran\n",
      { kind: "finished", code: 0 },
      null,
    ],
    [
      "Electron whose install fails",
      "fail",
      "install\n",
      "",
      { kind: "finished", code: 1 },
      "electron",
    ],
  ] as const)(
    "with %s, the copy settles it before the command starts",
    async (_, state, installs, output, outcome, install) => {
      const root = NodeFS.mkdtempSync(NodePath.join(dir, "settle-"));
      const web = NodePath.join(root, "apps", "web");
      NodeFS.mkdirSync(web, { recursive: true });
      const log = NodePath.join(root, "log");
      if (state !== null) {
        const electron = NodePath.join(
          root,
          "node_modules",
          ".pnpm",
          "electron@44.10.1",
          "node_modules",
          "electron",
        );
        NodeFS.mkdirSync(NodePath.join(electron, "dist"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(electron, "install.js"),
          `require("fs").appendFileSync(${JSON.stringify(log)}, "install\\n");
${state === "fail" ? "process.exit(1);" : ""}
require("fs").writeFileSync(__dirname + "/path.txt", "electron");
require("fs").writeFileSync(__dirname + "/dist/electron", "");`,
        );
        if (state === "linux" || state === "gone") {
          NodeFS.writeFileSync(NodePath.join(electron, "path.txt"), "electron");
        }
        if (state === "linux")
          NodeFS.writeFileSync(NodePath.join(electron, "dist", "electron"), "");
      }
      const tool = NodePath.join(root, "node_modules", ".bin");
      NodeFS.mkdirSync(tool, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(tool, "t3-tests"), `#!/bin/sh\necho ran\n`, {
        mode: 0o755,
      });
      const stdout: Buffer[] = [];
      const phases: string[] = [];
      const run = startLinuxRun({
        // Stands in for `remoto-rodar`: it marks the start, runs the wrapper, and marks the exit.
        remoto: fake(
          `printf '${M} phase=running pgid=4\\n' >&2; "$@"; c=$?; printf '${M} exit=%s\\n' $c >&2; exit $c`,
        ),
        program: "t3-tests",
        args: [],
        cwd: web,
        root,
        environment: process.env,
        machine: DEFAULT_MACHINE_CONFIG,
        macOnly: [],
        onProgress: (progress) => phases.push(progress.phase ?? ""),
        stdout: (chunk) => stdout.push(chunk),
        stderr: () => {},
      });
      const result = await run.done;
      expect(result.outcome).toEqual(outcome);
      expect(result.install).toBe(install);
      expect(NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8") : "").toBe(installs);
      expect(Buffer.concat(stdout).toString("utf8")).toBe(output);
      expect(phases.includes("installing")).toBe(installs !== "");
    },
  );

  it("notes an install failure the command's own output reports", async () => {
    const { run } = runWith(
      fake(
        [
          `printf '${M} phase=running pgid=4\\n' >&2`,
          "echo 'Error: Electron failed to install correctly.' >&2",
          `printf '${M} exit=1\\n' >&2`,
          "exit 1",
        ].join("\n"),
      ),
    );
    const result = await run.done;
    expect(result.outcome).toEqual({ kind: "finished", code: 1 });
    expect(result.install).toBe("electron");
  });

  it("runs with the env it is handed, ahead of the command", () => {
    expect(withProjectBins(["vp", "run", "x"], "/w", "/w", ["A=1", "B=x y"]).slice(3)).toEqual([
      "t3",
      "env",
      "A=1",
      "B=x y",
      "vp",
      "run",
      "x",
    ]);
  });

  it("runs the nearest project tool from the job's folder, then the checkout's", async () => {
    const web = NodePath.join(dir, "apps", "web");
    const tool = (folder: string, name: string, text: string) => {
      const bin = NodePath.join(folder, "node_modules", ".bin");
      NodeFS.mkdirSync(bin, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\necho ${text}\n`, { mode: 0o755 });
    };
    tool(dir, "vp", "root-vp");
    tool(dir, "vitest", "root-vitest");
    tool(web, "vp", "web-vp");
    // Stands in for `remoto-rodar`, which runs the command in the same folder of the copy.
    const { run, out } = runWith(fake('exec "$@"'), "vp; vitest", web);
    expect((await run.done).outcome).toEqual({ kind: "unavailable", touched: false });
    expect(out()).toBe("web-vp\nroot-vitest\n");
  });

  it.each([
    ["nope-not-installed", { kind: "missing", tool: "nope-not-installed" }, ""],
    ["t3-present", { kind: "unavailable", touched: false }, "present\n"],
  ] as const)("checks %s resolves there before running it", async (program, outcome, output) => {
    const bin = NodePath.join(dir, "node_modules", ".bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bin, "t3-present"), "#!/bin/sh\necho present\n", {
      mode: 0o755,
    });
    const stdout: Buffer[] = [];
    const run = startLinuxRun({
      // Stands in for `remoto-rodar`: the wrapper runs as it would there.
      remoto: fake('exec "$@"'),
      program,
      args: [],
      cwd: dir,
      root: dir,
      environment: process.env,
      machine: DEFAULT_MACHINE_CONFIG,
      macOnly: [],
      onProgress: () => {},
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });
    expect((await run.done).outcome).toEqual(outcome);
    expect(Buffer.concat(stdout).toString("utf8")).toBe(output);
  });

  it("reads a lost connection after the start as dropped, and exit 75 as unavailable", async () => {
    const dropped = runWith(fake(`printf '${M} phase=running pgid=9\\n' >&2; exit 255`));
    expect((await dropped.run.done).outcome).toEqual({ kind: "dropped" });
    const down = runWith(fake("echo '[remoto] PC indisponível.' >&2; exit 75"));
    expect((await down.run.done).outcome).toEqual({ kind: "unavailable", touched: false });
    expect(down.err()).toBe("[remoto] PC indisponível.\n");
  });

  it("reports a missing remoto as never started", async () => {
    const missing = runWith(NodePath.join(dir, "does-not-exist"));
    expect((await missing.run.done).outcome).toEqual({ kind: "unavailable", touched: false });
    expect(missing.err()).toContain("cannot run remoto");
  });

  it("kill ends the local remoto", async () => {
    const long = runWith(fake(`printf '${M} phase=running pgid=9\\n' >&2; exec sleep 30`));
    await long.running;
    long.run.kill("SIGTERM");
    expect((await long.run.done).outcome).toEqual({ kind: "dropped" });
  });

  it("finds remoto on PATH, in ~/.local/bin, or where T3CODE_REMOTO says", () => {
    const bin = NodePath.join(dir, "bin");
    const home = NodePath.join(dir, "home");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, ".local", "bin"), { recursive: true });
    expect(resolveRemoto({ PATH: bin, HOME: home })).toBeNull();
    NodeFS.writeFileSync(NodePath.join(home, ".local", "bin", "remoto"), "", { mode: 0o755 });
    expect(resolveRemoto({ PATH: bin, HOME: home })).toBe(
      NodePath.join(home, ".local", "bin", "remoto"),
    );
    NodeFS.writeFileSync(NodePath.join(bin, "remoto"), "", { mode: 0o755 });
    expect(resolveRemoto({ PATH: bin, HOME: home })).toBe(NodePath.join(bin, "remoto"));
    expect(resolveRemoto({ T3CODE_REMOTO: "/x/remoto" })).toBe("/x/remoto");
  });
});

describe("ssh calls around a Linux run", () => {
  const env = (ssh: string) => ({ ...process.env, T3CODE_RUNNER_SSH: ssh });

  it("a heartbeat reads load, cores and memory, or says why it failed", async () => {
    const ok = fake("printf '0.50 0.4 0.3 1/2 3\\n4\\nMem: 100 10 20 0 0 80\\n'");
    expect(await checkLinux(DEFAULT_MACHINE_CONFIG, env(ok))).toEqual({
      ok: true,
      reading: { load1: 0.5, cpuCount: 4, totalMemoryBytes: 100, availableMemoryBytes: 80 },
    });
    const refused = fake(
      "echo 'ssh: connect to host pc port 22: Connection refused' >&2; exit 255",
    );
    expect(await checkLinux(DEFAULT_MACHINE_CONFIG, env(refused))).toEqual({
      ok: false,
      error: "ssh: connect to host pc port 22: Connection refused",
    });
    expect(await checkLinux(DEFAULT_MACHINE_CONFIG, env(fake("exit 255")))).toEqual({
      ok: false,
      error: "ssh exited 255",
    });
  });

  it.each([
    ["echo gone", "gone", true],
    ["echo stopped", "stopped", true],
    ["echo killed", "killed", true],
    ["echo alive; exit 1", "alive", false],
    ["exit 255", "unreachable", false],
  ] as const)("a stop check printing %j is %s", async (body, result, clean) => {
    const answer = await stopRemote(DEFAULT_MACHINE_CONFIG, env(fake(body)), "app-1", 5);
    expect(answer).toBe(result);
    expect(confirmed(answer)).toBe(clean);
  });

  it.each([
    ["echo removed", "removed"],
    ["echo busy", "busy"],
    ["echo nonsense", "unreachable"],
    ["exit 255", "unreachable"],
  ] as const)("a copy removal printing %j is %s", async (body, result) => {
    expect(await removeRunnerCopy(DEFAULT_MACHINE_CONFIG, env(fake(body)), "app-0123abcd")).toBe(
      result,
    );
  });
});

describe("check:changed's inputs, computed on this Mac", () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-changed-"));
  const write = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, file), text);
  };
  write("package.json", JSON.stringify({ scripts: { "check:changed": "node scripts/cc.ts" } }));
  write("scripts/cc.ts", "process.env.CHECK_CHANGED_FILES");
  write("apps/web/package.json", JSON.stringify({ scripts: { test: "vitest" } }));
  /** Answers git as a repo whose origin/main is 3 ahead-of-base and upstream/main 1. */
  const git = (args: ReadonlyArray<string>) => {
    const line = args.join(" ");
    if (line === "remote") return "origin\nupstream";
    if (line === "merge-base HEAD refs/remotes/origin/main") return "aaa";
    if (line === "merge-base HEAD refs/remotes/upstream/main") return "bbb";
    if (line === "merge-base HEAD v1") return "ccc";
    if (line.startsWith("rev-list")) return line.includes("aaa") ? "3" : "1";
    if (line.startsWith("diff")) return `b.ts\na.ts\n${args[3]}.ts`;
    if (line.startsWith("ls-files")) return "new.ts\na.ts";
    return null;
  };
  it.each([
    [
      ["run", "check:changed"],
      repo,
      [
        "CHECK_CHANGED_BASE=bbb",
        "CHECK_CHANGED_REF=upstream/main",
        "CHECK_CHANGED_FILES=a.ts\nb.ts\nbbb.ts\nnew.ts",
      ],
    ],
    // An explicit ref after the script wins over the closest remote main.
    [
      ["run", "check:changed", "--", "--timeout", "3300", "--concurrency", "4", "v1"],
      NodePath.join(repo, "apps/web"),
      [
        "CHECK_CHANGED_BASE=ccc",
        "CHECK_CHANGED_REF=v1",
        "CHECK_CHANGED_FILES=a.ts\nb.ts\nccc.ts\nnew.ts",
      ],
    ],
    // Not that check, or a ref git doesn't know.
    [["test", "run"], repo, null],
    [
      ["run", "check:changed", "--timeout", "3300"],
      repo,
      [
        "CHECK_CHANGED_BASE=bbb",
        "CHECK_CHANGED_REF=upstream/main",
        "CHECK_CHANGED_FILES=a.ts\nb.ts\nbbb.ts\nnew.ts",
      ],
    ],
    [["run", "check:changed", "nope"], repo, null],
  ] as const)("%j from %s hands over %j", (args, cwd, expected) => {
    expect(changedInputs(args, cwd, repo, git)).toEqual(expected);
  });

  it("is null when the project's check:changed doesn't read the inputs", () => {
    const other = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-changed-"));
    NodeFS.writeFileSync(
      NodePath.join(other, "package.json"),
      JSON.stringify({ scripts: { "check:changed": "node ci.mjs" } }),
    );
    NodeFS.writeFileSync(NodePath.join(other, "ci.mjs"), "git diff");
    expect(changedInputs(["run", "check:changed"], other, other, git)).toBeNull();
  });
});
