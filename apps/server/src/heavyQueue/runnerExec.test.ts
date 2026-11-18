// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTty from "node:tty";
import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_MACHINE_CONFIG } from "./runner.ts";
import {
  bringBack,
  changedInputs,
  checkLinux,
  confirmed,
  forwardedInput,
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

const runWith = (remoto: string, script = "vp test run", cwd = dir, input?: number) => {
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
    ...(input === undefined ? {} : { input }),
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
    ["a file", () => NodeFS.openSync(NodePath.join(dir, "input.txt"), "w+"), true],
    [
      "a pipe",
      () => {
        const fifo = NodePath.join(dir, "input.fifo");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        return NodeFS.openSync(fifo, NodeFS.constants.O_RDWR | NodeFS.constants.O_NONBLOCK);
      },
      true,
    ],
    ["/dev/null", () => NodeFS.openSync("/dev/null", "r"), false],
    [
      "a TTY",
      () => {
        const fd = NodeFS.openSync("/dev/ptmx", "r+");
        expect(NodeTty.isatty(fd)).toBe(true);
        return fd;
      },
      false,
    ],
  ])("forwards %s as the command's input: %s", (_, open, forwarded) => {
    const fd = open();
    try {
      expect(forwardedInput(fd)).toBe(forwarded ? fd : undefined);
    } finally {
      NodeFS.closeSync(fd);
    }
  });

  it.each([
    ["with input", "x", "1|x"],
    ["without input", undefined, "|"],
  ])("hands remoto the job's stdin %s and keeps the code", async (_, text, sent) => {
    const file = NodePath.join(dir, "stdin.txt");
    NodeFS.writeFileSync(file, text ?? "");
    const fd = text === undefined ? undefined : NodeFS.openSync(file, "r");
    try {
      const remoto = fake(
        [
          `printf '${M} phase=running pgid=4\n' >&2`,
          'printf "%s|" "$REMOTO_STDIN"; cat',
          `printf '${M} exit=3\n' >&2`,
          "exit 3",
        ].join("\n"),
      );
      const { run, out } = runWith(remoto, "vp fmt --stdin-filepath=a.ts", dir, fd);
      expect((await run.done).outcome).toEqual({ kind: "finished", code: 3 });
      expect(out()).toBe(sent);
    } finally {
      if (fd !== undefined) NodeFS.closeSync(fd);
    }
  });

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
    ["./scripts/check.sh", ["--all"], ["./scripts/check.sh", "--all"]],
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
    [
      "[[ $x =~ ^a ]] && cat <~/wt/a >~/wt/b",
      `[[ $x =~ ^a ]] && cat <"$T3_COPY"'/a' >"$T3_COPY"'/b'`,
    ],
    // Bash expands `~` after an identifier's `=`, in an assignment or an argument alike.
    [
      "FOO=~/wt/x BAR=/Users/me/wt/y env BAZ=$HOME/wt vp test",
      `FOO="$T3_COPY"'/x' BAR="$T3_COPY"'/y' env BAZ="$T3_COPY" vp test`,
    ],
    // And after each `:` of that value: a PATH-like list.
    [
      "PATH=/x:~/wt/bin:$PATH env P=/Users/me/wt/a:$HOME/wt/b:~other:~/wt vp test",
      `PATH=/x:"$T3_COPY"'/bin':$PATH env P="$T3_COPY"'/a':"$T3_COPY"'/b':~other:"$T3_COPY" vp test`,
    ],
    // Not the checkout, a quoted `~`, another home or variable: left as written.
    [
      "echo 'X=~/wt' X=\\~/wt --root=~/wt a:~/wt a~/wt",
      "echo 'X=~/wt' X=\\~/wt --root=~/wt a:~/wt a~/wt",
    ],
    ["cd /Users/me/other && vp test", "cd /Users/me/other && vp test"],
    ["cd /Users/me/wt-2 && vp test", "cd /Users/me/wt-2 && vp test"],
    ["echo '~/wt' $WT/x ~other/wt", "echo '~/wt' $WT/x ~other/wt"],
  ])("sh -c %j runs there as %j", (text, expected) => {
    expect(
      remoteCommand("/bin/sh", ["-ec", text], "/Users/me/wt/apps/web", "/Users/me/wt", "/Users/me"),
    ).toEqual(["bash", "-ec", expected]);
  });

  it.each([
    ["/r/apps/web/a.ts /r", `"$T3_COPY"'/apps/web/a.ts' "$T3_COPY"`],
    // Not a sibling such as `/r-2`, nor a longer path holding `/r`; a flag's value and quotes are.
    [
      "/r-2/a /r2/a /x/r/a --dir=/r/b '/r'",
      `/r-2/a /r2/a /x/r/a '--dir='"$T3_COPY"'/b' "$T3_COPY"`,
    ],
  ])("sh -c %j from /r/apps runs there as %j", (text, expected) => {
    expect(remoteCommand("/bin/sh", ["-c", text], "/r/apps", "/r", "/Users/me")).toEqual([
      "bash",
      "-c",
      expected,
    ]);
  });

  // `remoto` syncs the folder's git root as `pwd -P` sees it, and starts in the same folder there.
  it.each([
    ["the repo root", "", "", "/apps/web", `cd "$T3_COPY"'/apps/web' && vp test`],
    ["a subfolder", "", "/apps/web", "'/apps'", `cd "$T3_COPY"'/apps' && vp test`],
    ["a folder outside git", "plain", "", "/a.ts", `vp test "$T3_COPY"'/a.ts' /etc/x`],
    // A git worktree's `.git` is a file; its main checkout is another folder, left as written.
    ["a git worktree", "worktree", "", "/apps/web", `cd "$T3_COPY"'/apps/web' && vp test MAIN/a`],
  ])("from %s, a Mac path inside the copy points at it", async (_where, kind, sub, path, given) => {
    const repo = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(dir, "t3-repo-")));
    const main = `${repo}.main`;
    const sent = given.replace("MAIN", main);
    if (kind === "") NodeFS.mkdirSync(NodePath.join(repo, ".git"));
    if (kind === "worktree") {
      NodeFS.writeFileSync(NodePath.join(repo, ".git"), `gitdir: ${main}/.git/worktrees/w\n`);
    }
    NodeFS.mkdirSync(NodePath.join(repo, "apps", "web"), { recursive: true });
    const quoted = path.startsWith("'") ? `'${repo}${path.slice(1)}` : `${repo}${path}`;
    const line =
      kind === "plain"
        ? `vp test ${quoted} /etc/x`
        : `cd ${quoted} && vp test${kind === "worktree" ? ` ${main}/a` : ""}`;
    const stdout: Buffer[] = [];
    const run = startLinuxRun({
      // Past the PATH wrapper, to the command it runs.
      remoto: fake('[ "$4" = t3 ] && shift 4; printf "%s\\n" "$@"'),
      program: `${repo}/node_modules/.bin/zsh`,
      args: ["-c", line],
      cwd: `${repo}${sub}`,
      root: repo,
      environment: process.env,
      machine: DEFAULT_MACHINE_CONFIG,
      macOnly: [],
      onProgress: () => {},
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });
    await run.done;
    expect(Buffer.concat(stdout).toString("utf8")).toBe(`bash\n-c\n${sent}\n`);
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

  // The job is on Linux already: a script that calls `remoto` itself runs that part there too.
  it("a remoto the command calls inside runs in place there", async () => {
    const stdout: Buffer[] = [];
    const run = startLinuxRun({
      remoto: fake('exec "$@"'),
      program: "/bin/zsh",
      args: ["-c", "remoto echo nested && sh -c 'remoto echo deep' && remoto"],
      cwd: dir,
      root: dir,
      environment: { ...process.env, PATH: "/usr/bin:/bin" },
      machine: DEFAULT_MACHINE_CONFIG,
      macOnly: [],
      onProgress: () => {},
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });
    await run.done;
    expect(Buffer.concat(stdout).toString("utf8")).toBe("nested\ndeep\n");
  });

  // Only the install before the command is the worktree's: the command may print the same text.
  it.each([
    ["installing", "pnpm-lock.yaml is out of date in this worktree"],
    ["running", null],
  ])("an outdated lockfile while %s tells the worktree's fix: %j", async (phase, fix) => {
    const lockfile = 'help: Update your lockfile using "pnpm install --no-frozen-lockfile"';
    const { run } = runWith(
      fake(`printf '${M} phase=${phase}\\n' >&2; echo '${lockfile}' >&2; exit 1`),
    );
    const { worktree } = await run.done;
    expect(worktree === null ? null : worktree.slice(0, fix?.length)).toBe(fix);
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

  // A failing vitest run once quoted an install error in a test name and was filed as an install.
  it.each([
    [
      "a vitest failure quoting one",
      "running",
      [
        "printf '\\033[41m\\033[1m FAIL \\033[22m\\033[49m src/a.test.ts > EEXIST row\\n' >&2",
        "echo \"Error: EEXIST: file already exists, mkdir 'node_modules/sharp/vendor'\" >&2",
        "printf '\\033[31m\\033[2m⎯⎯⎯⎯[50/62]⎯\\033[22m\\033[39m\\n' >&2",
      ],
      null,
    ],
    [
      "Electron's error printed by the command",
      "running",
      ["echo 'Error: Electron failed to install correctly.' >&2"],
      null,
    ],
    [
      "output that is only ANSI",
      "running",
      ["printf '\\033[31m\\033[2m⎯⎯⎯\\033[22m\\033[39m\\n' >&2"],
      null,
    ],
    [
      "an install that really fails",
      "installing",
      ["echo \"Error: EEXIST: file already exists, mkdir 'node_modules/sharp/vendor'\" >&2"],
      "sharp",
    ],
  ] as const)("%s while %s is an install failure of %j", async (_case, phase, lines, install) => {
    const { run } = runWith(
      fake(
        [
          `printf '${M} phase=${phase} pgid=4\\n' >&2`,
          ...lines,
          `printf '${M} exit=1\\n' >&2`,
          "exit 1",
        ].join("\n"),
      ),
    );
    const result = await run.done;
    expect(result.outcome).toEqual({ kind: "finished", code: 1 });
    expect(result.install).toBe(install);
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
      reading: {
        cpuPercent: null,
        load1: 0.5,
        cpuCount: 4,
        totalMemoryBytes: 100,
        availableMemoryBytes: 80,
      },
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

describe("bringing results back", () => {
  const T0 = 1_800_000_000;
  const COPY = "app-0123abcd";
  /** Linux's home with the copy and the job's start marker, and the Mac checkout. */
  const setup = () => {
    const home = NodeFS.mkdtempSync(NodePath.join(dir, "linux-home-"));
    const copy = NodePath.join(home, "runs", COPY);
    NodeFS.mkdirSync(copy, { recursive: true });
    const marker = `${copy}.t3-start-job-1`;
    NodeFS.writeFileSync(marker, "");
    const root = NodeFS.mkdtempSync(NodePath.join(dir, "mac-"));
    const environment = {
      ...process.env,
      T3_FAKE_HOME: home,
      // Runs the command in Linux's home, as ssh would.
      T3CODE_RUNNER_SSH: fake('eval "c=\\${$#}"; cd "$T3_FAKE_HOME" && exec sh -c "$c"'),
      // Copies each listed file from the copy there, as rsync --files-from would.
      T3CODE_RUNNER_RSYNC: fake(
        [
          'for a; do case "$a" in --files-from=*) list="${a#--files-from=}";; esac; done',
          'eval "src=\\${$(($# - 1))}"; eval "dst=\\${$#}"; src="$T3_FAKE_HOME/${src#*:}"',
          'while IFS= read -r f; do mkdir -p "$dst$(dirname "$f")"; cp "$src$f" "$dst$f"; done < "$list"',
        ].join("\n"),
      ),
    };
    const back = () =>
      bringBack({
        machine: DEFAULT_MACHINE_CONFIG,
        environment,
        copyId: COPY,
        job: "job-1",
        root,
        since: T0 * 1000,
      });
    return { copy, marker, root, environment, back };
  };
  const write = (path: string, text: string, at: number) => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, text);
    NodeFS.utimesSync(path, at, at);
  };

  it.each([
    ["created", "sub/new.txt", "after", null, "copied"],
    ["changed", "changed.txt", "after", "before", "copied"],
    ["changed on this Mac during the job", "conflict.txt", "after", "after", "skipped"],
    ["older than the job", "old.txt", "before", "before", "left"],
    ["in node_modules", "node_modules/x/index.js", "after", null, "left"],
    ["in a nested node_modules", "apps/web/node_modules/y.js", "after", null, "left"],
    ["in .git", ".git/HEAD", "after", null, "left"],
  ] as const)("a file %s (%s) is %s", async (_, path, linux, mac, result) => {
    const { copy, marker, root, back } = setup();
    // Linux compares change times, which only the clock sets: the marker moves instead. The
    // file's own time is older than either, as a synced or `cp -p` file keeps it.
    write(NodePath.join(copy, path), "linux", 500_000_000);
    const start = linux === "after" ? 1_000_000_000 : 4_000_000_000;
    NodeFS.utimesSync(marker, start, start);
    if (mac !== null) write(NodePath.join(root, path), "mac", mac === "after" ? T0 + 5 : T0 - 100);
    expect(await back()).toEqual({
      copied: result === "copied" ? [path] : [],
      skipped: result === "skipped" ? [path] : [],
    });
    const here = NodePath.join(root, path);
    expect(NodeFS.existsSync(here) ? NodeFS.readFileSync(here, "utf8") : null).toBe(
      result === "copied" ? "linux" : mac === null ? null : "mac",
    );
    expect(NodeFS.existsSync(marker)).toBe(false);
  });

  it("is null when Linux can't list or send them, and leaves this Mac alone", async () => {
    const { copy, root, marker, environment } = setup();
    write(NodePath.join(copy, "new.txt"), "linux", T0 + 10);
    NodeFS.utimesSync(marker, 1_000_000_000, 1_000_000_000);
    const args = { machine: DEFAULT_MACHINE_CONFIG, copyId: COPY, job: "job-1", root, since: 0 };
    const down = { ...environment, T3CODE_RUNNER_SSH: fake("exit 255") };
    expect(await bringBack({ ...args, environment: down })).toBeNull();
    const failing = { ...environment, T3CODE_RUNNER_RSYNC: fake("exit 12") };
    expect(await bringBack({ ...args, environment: failing })).toBeNull();
    expect(NodeFS.existsSync(NodePath.join(root, "new.txt"))).toBe(false);
    // The listing took the marker: with none left, there is nothing to list.
    expect(NodeFS.existsSync(marker)).toBe(false);
    expect(await bringBack({ ...args, environment })).toBeNull();
  });

  it.each([
    ["on", "job-1", true],
    ["off", undefined, false],
  ] as const)(
    "with the setting %s, the wrapper marks the job's start: %s",
    async (_, job, marked) => {
      const root = NodeFS.mkdtempSync(NodePath.join(dir, "marked-"));
      const run = startLinuxRun({
        // Stands in for `remoto-rodar`: the wrapper runs as it would there.
        remoto: fake('exec "$@"'),
        program: "true",
        args: [],
        cwd: root,
        root,
        environment: process.env,
        machine: DEFAULT_MACHINE_CONFIG,
        macOnly: [],
        ...(job === undefined ? {} : { startMarker: job }),
        onProgress: () => {},
        stdout: () => {},
        stderr: () => {},
      });
      await run.done;
      expect(NodeFS.existsSync(`${root}.t3-start-job-1`)).toBe(marked);
    },
  );

  it("refuses ids that could escape the runs folder", async () => {
    expect(() => withProjectBins(["vp"], "/w", "/w", [], "../x")).toThrow(/Unsafe/);
    const { environment } = setup();
    const args = { machine: DEFAULT_MACHINE_CONFIG, environment, root: dir, since: 0 };
    expect(await bringBack({ ...args, copyId: "..", job: "job-1" })).toBeNull();
    expect(await bringBack({ ...args, copyId: COPY, job: "../x" })).toBeNull();
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
