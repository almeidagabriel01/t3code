import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SRC = NodePath.join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("menu symbols", () => {
  // Android renders menu `image` names through this map; a missing name shows no icon at all.
  it("every menu image has an Android icon", () => {
    const map = NodeFS.readFileSync(
      NodePath.join(SRC, "components/ui/AppSymbol.android.tsx"),
      "utf8",
    );
    const mapped = new Set(
      [...map.matchAll(/^\s+"?([a-z0-9._]+)"?:\s*Icon\w+,$/gm)].map((match) => match[1]),
    );
    const missing = sourceFiles(SRC).flatMap((file) =>
      [...NodeFS.readFileSync(file, "utf8").matchAll(/\bimage: ([^,\n]+)/g)]
        .filter((match) => /^"| \? /.test(match[1]!))
        .flatMap((match) =>
          [...match[1]!.replace(/===\s*"[^"]*"/g, "").matchAll(/"([a-z0-9._]+)"/g)].map(
            (name) => name[1]!,
          ),
        )
        .filter((name) => !mapped.has(name))
        .map((name) => `${file.slice(SRC.length + 1)}: ${name}`),
    );
    expect(missing).toEqual([]);
  });
});
