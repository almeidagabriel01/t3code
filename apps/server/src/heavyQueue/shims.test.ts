// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { heavySegment } from "./heavyHook.ts";
import { ensureShims, realProgram, withoutShims } from "./shims.ts";

const setup = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 shims "));
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(bin);
  for (const name of ["vp", "pnpm", "cargo", "docker", "npx", "vitest", "make"]) {
    NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\necho "real ${name}"\n`, {
      mode: 0o755,
    });
  }
  // The call prints what it was given instead of starting T3.
  const shims = ensureShims(NodePath.join(dir, "q"), "echo CALL");
  return { dir, bin, shims, path: `${shims}:${bin}:/usr/bin:/bin` };
};

describe("PATH shims", () => {
  // Light calls exec the real program at once; the filter must flag every call `heavyWords` does.
  it.each([
    ["pnpm --version", false],
    ["vp fmt --stdin-filepath=a.ts", false],
    ["vp staged", false],
    ["docker ps", false],
    ["pnpm add left-pad", false],
    ["vp lint a.ts b.ts", true],
    ["vp test run x.test.ts", true],
    ["vp t", true],
    ["vp run knip:check", true],
    ["pnpm --filter web run build", true],
    ["pnpm -C apps/server exec vitest run", true],
    ["npx vitest run", true],
    ["cargo test", true],
    ["docker compose up", true],
    ["make check", true],
    ["vp fmt", true],
    ["vitest", true],
    // Missing on this Mac: only Linux may have it, so the call still goes out.
    ["pytest -x", true],
  ])("%j calls t3: %s", (line, calls) => {
    const { dir, path } = setup();
    try {
      const [name, ...args] = line.split(" ");
      const out = NodeChildProcess.execFileSync(NodePath.join(dir, "q", "shims", name!), args, {
        env: { PATH: path, T3CODE_HEAVY_JOB: "1" },
        encoding: "utf8",
      });
      expect(out).toBe(calls ? `CALL -- ${line}\n` : `real ${name}\n`);
      if (heavySegment(line) !== null) expect(calls).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the real program outside a job, and finds it past every shim folder", () => {
    const { dir, bin, shims, path } = setup();
    try {
      const out = NodeChildProcess.execFileSync(NodePath.join(shims, "vp"), ["test", "run"], {
        env: { PATH: path },
        encoding: "utf8",
      });
      expect(out).toBe("real vp\n");
      expect(withoutShims(path)).toBe(`${bin}:/usr/bin:/bin`);
      expect(realProgram("vp", path)).toBe(NodePath.join(bin, "vp"));
      // Rewritten only when it changed: a concurrent job never sees a half-written shim.
      const before = NodeFS.statSync(NodePath.join(shims, "vp")).mtimeMs;
      ensureShims(NodePath.join(dir, "q"), "echo CALL");
      expect(NodeFS.statSync(NodePath.join(shims, "vp")).mtimeMs).toBe(before);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
