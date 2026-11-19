import { describe, expect, it } from "vite-plus/test";

import { openConversationKey } from "./open-conversation-key";

const at = (...routes: Array<{ name: string; params?: object }>) => ({
  index: routes.length - 1,
  routes,
});

describe("openConversationKey", () => {
  it.each([
    [
      "a thread",
      at({ name: "Thread", params: { environmentId: "hub", threadId: "t1" } }),
      "hub:t1",
    ],
    [
      "an assistant's conversation",
      at({ name: "Thread", params: { environmentId: "hub", threadId: "assistant:a1:1" } }),
      "hub:assistant:a1:1",
    ],
    [
      "a group chat above a thread",
      at(
        { name: "Thread", params: { environmentId: "hub", threadId: "t1" } },
        { name: "AssistantGroupChat", params: { environmentId: "hub", teamId: "g1" } },
      ),
      "hub:assistant-group:g1",
    ],
    [
      "a thread opened from a group chat",
      at(
        { name: "AssistantGroupChat", params: { environmentId: "hub", teamId: "g1" } },
        { name: "Thread", params: { environmentId: "hub", threadId: "t2" } },
      ),
      "hub:t2",
    ],
    ["a screen with no conversation", at({ name: "Settings" }), null],
    ["a new-task draft route", at({ name: "Thread", params: { draft: {} } }), null],
    [
      "a group route missing its team",
      at({ name: "AssistantGroupChat", params: { environmentId: "hub" } }),
      null,
    ],
  ])("names %s", (_, state, expected) => {
    expect(openConversationKey(state)).toBe(expected);
  });

  it("ignores routes above the focused one", () => {
    const state = at(
      { name: "Thread", params: { environmentId: "hub", threadId: "t1" } },
      { name: "AssistantGroupChat", params: { environmentId: "hub", teamId: "g1" } },
    );
    expect(openConversationKey({ ...state, index: 0 })).toBe("hub:t1");
  });
});
