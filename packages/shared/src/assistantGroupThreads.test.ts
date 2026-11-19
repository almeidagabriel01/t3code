import { describe, expect, it } from "vite-plus/test";

import { groupThreadId, nextGroupThreadId, requestThreadId } from "./assistantGroupThreads.ts";

describe("assistant group thread ids", () => {
  // Expected ids come from node:crypto, so the shared hash matches the server's old derivation.
  it.each([
    ["member", groupThreadId("ada", "team-1"), "assistant:ada:g-7e2a2d5f9a3050f8"],
    [
      "member, team id with ':'",
      groupThreadId("ada", "team:a:b"),
      "assistant:ada:g-16280d1ea544fdc8",
    ],
    ["request", requestThreadId("ada", "team-1", "msg-9"), "assistant:ada:g-a634f8a2a67e76fd"],
    [
      "replacement",
      nextGroupThreadId("ada", "team-1", "assistant:ada:g-dead"),
      "assistant:ada:g-8b7d7d54e23f6de8",
    ],
  ])("%s", (_case, actual, expected) => {
    expect(actual).toBe(expected);
  });
});
