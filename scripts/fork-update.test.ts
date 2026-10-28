import { assert, describe, it } from "@effect/vitest";

import { findDmg, parseArgs, parseConflictFiles, parseCount } from "./fork-update.ts";

describe("fork-update helpers", () => {
  it("parses flags and rejects unknown ones", () => {
    assert.deepStrictEqual(parseArgs(["--push", "--install"]), {
      dryRun: false,
      push: true,
      install: true,
      rebuild: false,
    });
    assert.throws(() => parseArgs(["--force"]), /Unknown option/);
  });

  it("parses the behind count", () => {
    assert.strictEqual(parseCount("103\n"), 103);
    assert.throws(() => parseCount("fatal"));
  });

  it("parses conflicted files", () => {
    assert.deepStrictEqual(parseConflictFiles("a.ts\n\n b/c.ts \n"), ["a.ts", "b/c.ts"]);
    assert.deepStrictEqual(parseConflictFiles(""), []);
  });

  it("picks the newest dmg for the arch", () => {
    const entries = [
      { name: "T3-Code-1.0.0-arm64.dmg", mtimeMs: 1 },
      { name: "T3-Code-1.1.0-arm64.dmg", mtimeMs: 5 },
      { name: "T3-Code-1.2.0-x64.dmg", mtimeMs: 9 },
      { name: "latest-mac.yml", mtimeMs: 10 },
    ];
    assert.strictEqual(findDmg(entries, "arm64"), "T3-Code-1.1.0-arm64.dmg");
    assert.strictEqual(findDmg([], "arm64"), null);
  });
});
