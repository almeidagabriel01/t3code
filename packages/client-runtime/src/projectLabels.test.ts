import { describe, expect, it } from "vite-plus/test";

import { projectPickerLabels } from "./projectLabels.ts";

const p = (title: string, workspaceRoot: string) => ({ title, workspaceRoot });

describe("projectPickerLabels", () => {
  it.each([
    ["no projects", [], []],
    ["unique titles", [p("web", "/a/web"), p("api", "/a/api")], ["web", "api"]],
    [
      "shared title, different parents",
      [p("server", "/code/t3code/apps/server"), p("server", "/code/other-repo/server")],
      ["server · apps", "server · other-repo"],
    ],
    [
      "needs two segments",
      [p("server", "/x/a/apps/server"), p("server", "/x/b/apps/server")],
      ["server · a/apps", "server · b/apps"],
    ],
    [
      "leaf differs from the title",
      [p("App", "C:\\w\\one\\core"), p("App", "C:\\w\\two\\core")],
      ["App · one/core", "App · two/core"],
    ],
    ["one root nests the other", [p("s", "/a/s"), p("s", "/b/a/s")], ["s · a", "s · b/a"]],
    ["identical roots", [p("s", "/a/s"), p("s", "/a/s")], ["s · a", "s · a"]],
    ["root is just the title", [p("s", "/s"), p("s", "/s")], ["s · s", "s · s"]],
    ["empty root", [p("s", ""), p("s", "")], ["s", "s"]],
  ] as const)("%s", (_name, projects, expected) => {
    expect(projectPickerLabels(projects)).toEqual(expected);
  });
});
