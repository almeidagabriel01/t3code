import { ASSISTANT_STANDUP_PROMPT_HEAD, type AssistantId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  directReports,
  hasStandupTask,
  leaderChoices,
  teamLeaderBadge,
  teamMemberChoices,
  teamSubtitle,
  teamSummary,
} from "./assistantTeam.ts";

const member = (
  id: string,
  reportsTo: string | null,
  role = "",
  archivedAt: string | null = null,
) => ({
  id: id as AssistantId,
  name: id.toUpperCase(),
  role,
  reportsTo: reportsTo as AssistantId | null,
  archivedAt,
});
// a <- b <- c, d alone, e archived.
const all = [
  member("a", null, "CEO"),
  member("b", "a"),
  member("c", "b", "Eng"),
  member("d", null),
  member("e", null, "", "now"),
];

it("leaders can't be the assistant itself, anyone below it, or archived", () => {
  assert.deepEqual(
    leaderChoices(all, "b").map((entry) => entry.id),
    ["a", "d"],
  );
  assert.deepEqual(
    leaderChoices(all, "a").map((entry) => entry.id),
    ["d"],
  );
  assert.deepEqual(
    leaderChoices(all, null).map((entry) => entry.id),
    ["a", "b", "c", "d"],
  );
});

it("lists direct reports and the subtitle with names, never ids", () => {
  assert.deepEqual(
    directReports(all, "a").map((entry) => entry.id),
    ["b"],
  );
  assert.strictEqual(teamSubtitle(all[0]!, all), "CEO");
  assert.strictEqual(teamSubtitle(all[1]!, all), "reports to A");
  assert.strictEqual(teamSubtitle(all[2]!, all), "Eng · reports to B");
  assert.strictEqual(teamSubtitle(all[3]!, all), null);
});

it("finds a standup by its opening line on the assistant's own conversation only", () => {
  const standup = { threadId: "assistant:a:1", prompt: `${ASSISTANT_STANDUP_PROMPT_HEAD}\nAsk.` };
  assert.isTrue(hasStandupTask([standup], "assistant:a:1"));
  assert.isFalse(hasStandupTask([standup], "assistant:b:1"));
  assert.isFalse(hasStandupTask([{ ...standup, prompt: "Check in" }], "assistant:a:1"));
  assert.isFalse(hasStandupTask([standup], null));
});

it("a team shows its leader's title, falls back to Leader, and keeps archived members", () => {
  const team = { memberIds: ["a", "b", "e"], leaderId: "a", leaderTitle: "CEO" };
  assert.strictEqual(teamSummary(team, all), "3 members · A (CEO)");
  assert.strictEqual(teamLeaderBadge({ ...team, leaderTitle: null }), "Leader");
  assert.strictEqual(teamLeaderBadge({ ...team, leaderTitle: "" }), "Leader");
  assert.strictEqual(teamSummary({ ...team, leaderId: null, leaderTitle: null }, all), "3 members");
  assert.deepEqual(
    teamMemberChoices(all, team).map((entry) => entry.id),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(
    teamMemberChoices(all, null).map((entry) => entry.id),
    ["a", "b", "c", "d"],
  );
});
