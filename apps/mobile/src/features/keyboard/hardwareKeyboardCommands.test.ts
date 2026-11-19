import { describe, expect, it } from "vite-plus/test";

import { parseActiveGroupChatPath, parseActiveThreadPath } from "./hardwareKeyboardCommands";

describe("parseActiveThreadPath", () => {
  it("decodes route components", () => {
    expect(parseActiveThreadPath("/threads/local%20machine/thread%2Fone/review")).toEqual({
      environmentId: "local machine",
      threadId: "thread/one",
    });
  });

  it("ignores malformed encoded route components", () => {
    expect(parseActiveThreadPath("/threads/%E0%A4%A/thread-1")).toBeNull();
  });
});

describe("parseActiveGroupChatPath", () => {
  it.each([
    [
      "/assistant-groups/local%20machine/team%2Fone",
      { environmentId: "local machine", teamId: "team/one" },
    ],
    ["/assistant-groups/hub/crew/", { environmentId: "hub", teamId: "crew" }],
    ["/assistant-groups/hub/crew/info", null],
    ["/assistant-groups/%E0%A4%A/crew", null],
    ["/threads/hub/crew", null],
  ])("%s", (pathname, expected) => {
    expect(parseActiveGroupChatPath(pathname)).toEqual(expected);
  });
});
