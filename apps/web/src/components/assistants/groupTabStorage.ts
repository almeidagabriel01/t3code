import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The group chat tab this browser last showed for one group, kept in localStorage. */
export const SavedGroupTab = Schema.NullOr(Schema.String);

export const groupTabStorageKey = (environmentId: EnvironmentId, teamId: AssistantTeamId) =>
  `t3code:group-tab:${environmentId}:${teamId}`;
