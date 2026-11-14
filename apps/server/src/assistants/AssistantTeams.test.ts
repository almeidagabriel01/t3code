import { describe, expect, it } from "vite-plus/test";

import { toAssistantTeam } from "./AssistantTeams.ts";

const row = (overrides: Partial<Parameters<typeof toAssistantTeam>[0]> = {}) =>
  toAssistantTeam({
    team_id: "t1",
    name: "Beyond · Dev",
    member_ids_json: '["a1","a2"]',
    lead_id: null,
    latest_seq: 3,
    thread_ids_json: '["th-1"]',
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

describe("toAssistantTeam", () => {
  it.each([
    { name: "valid", overrides: {}, memberIds: ["a1", "a2"], threadIds: ["th-1"] },
    {
      name: "missing thread ids",
      overrides: { thread_ids_json: null },
      memberIds: ["a1", "a2"],
      threadIds: [],
    },
    {
      name: "corrupt thread ids",
      overrides: { thread_ids_json: "{" },
      memberIds: ["a1", "a2"],
      threadIds: [],
    },
    {
      name: "corrupt members",
      overrides: { member_ids_json: "nope" },
      memberIds: [],
      threadIds: ["th-1"],
    },
  ])("keeps the team when a row has $name", ({ overrides, memberIds, threadIds }) => {
    const team = row(overrides);
    expect(team.memberIds).toEqual(memberIds);
    expect(team.chat?.threadIds).toEqual(threadIds);
  });
});
