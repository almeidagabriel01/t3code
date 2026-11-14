import type { NavigationState } from "@react-navigation/native";
import { describe, expect, it } from "vite-plus/test";

import type { RootStackResetAction } from "../../lib/root-stack-reset";
import { openSettingsLink } from "./settings-navigation";

const state = {
  key: "root",
  index: 1,
  routes: [
    { key: "home", name: "Home" },
    { key: "thread", name: "Thread" },
  ],
} as unknown as NavigationState;

function open(href: string) {
  const actions: RootStackResetAction[] = [];
  const opened = openSettingsLink(
    {
      dispatch: (action) => actions.push(action),
      getParent: () => undefined,
      getState: () => state,
    },
    href,
  );
  expect(opened).toBe(actions.length > 0);
  return actions.map((action) => action.payload);
}

describe("openSettingsLink", () => {
  it("leaves other links alone", () => {
    expect(open("https://example.com")).toEqual([]);
  });

  it.each([
    [
      "t3-settings://v1/env-1/integrations#linear",
      [{ name: "SettingsIntegrations", params: { entry: "linear" } }],
    ],
    ["t3-settings://v1/env-1/memory", [{ name: "SettingsMemory", params: undefined }]],
    ["t3-settings://v1/env-1/not-a-page#linear", []],
    ["t3-settings://v1/", []],
  ])("%s", (href, pages) => {
    expect(open(href)).toEqual([
      {
        ...state,
        index: 1 + pages.length,
        routes: [{ key: "home", name: "Home" }, { name: "Settings" }, ...pages],
      },
    ]);
  });
});
