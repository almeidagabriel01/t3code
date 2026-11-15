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

/** The object literal around `index`, without its braces; braces inside strings are assumed balanced. */
function enclosingObject(source: string, index: number): string | null {
  let depth = 0;
  for (let start = index; start >= 0; start--) {
    if (source[start] === "}") depth++;
    else if (source[start] === "{" && depth-- === 0) {
      let end = start;
      for (let open = 0; end < source.length; end++) {
        if (source[end] === "{") open++;
        else if (source[end] === "}" && --open === 0) break;
      }
      return source.slice(start + 1, end);
    }
  }
  return null;
}

/** The object's own keys, `...` for a spread, skipping anything nested. */
function topLevelKeys(body: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let atKey = true;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if ("{[(".includes(char)) depth++;
    else if ("}])".includes(char)) depth--;
    else if (char === "," && depth === 0) {
      atKey = true;
      continue;
    }
    if (atKey && depth === 0 && !/\s/.test(char)) {
      const key = /^(\.\.\.|[A-Za-z_$][\w$]*)/.exec(body.slice(index))?.[1];
      if (key) keys.add(key);
      atKey = false;
    }
  }
  return keys;
}

describe("menu symbols", () => {
  // Android draws every titled group, inline or not, as a submenu row, so each one needs its own icon.
  it("every titled menu group has an icon", () => {
    const missing = sourceFiles(SRC).flatMap((file) => {
      const source = NodeFS.readFileSync(file, "utf8");
      return [...source.matchAll(/\b(subactions|items):/g)].flatMap((match) => {
        const body = enclosingObject(source, match.index);
        if (body === null) return [];
        const keys = topLevelKeys(body);
        const group = match[1] === "subactions" || keys.has("id");
        if (!group || !keys.has("title") || keys.has("...")) return [];
        if (keys.has("image") || keys.has("icon")) return [];
        const line = source.slice(0, match.index).split("\n").length;
        return [`${file.slice(SRC.length + 1)}:${line}`];
      });
    });
    expect([...new Set(missing)]).toEqual([]);
  });

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
