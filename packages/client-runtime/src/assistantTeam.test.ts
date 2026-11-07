import type { AssistantId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { teamMemberChoices, teamSubtitle, teamSummary } from "./assistantTeam.ts";

const member = (id: string, role = "", archivedAt: string | null = null) => ({
  id: id as AssistantId,
  name: id.toUpperCase(),
  role,
  archivedAt,
});
const all = [
  member("a", "CEO"),
  member("b"),
  member("c", "Eng"),
  member("d"),
  member("e", "", "now"),
];

it("a group shows its lead, keeps archived members, and the subtitle is the role", () => {
  assert.strictEqual(teamSubtitle(all[0]!), "CEO");
  assert.strictEqual(teamSubtitle(all[1]!), null);
  const team = { memberIds: ["a", "b", "e"], leadId: "a" };
  assert.strictEqual(teamSummary(team, all), "3 members · lead A");
  assert.strictEqual(teamSummary({ ...team, leadId: null }, all), "3 members");
  assert.deepEqual(
    teamMemberChoices(all, team).map((entry) => entry.id),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(
    teamMemberChoices(all, null).map((entry) => entry.id),
    ["a", "b", "c", "d"],
  );
});
