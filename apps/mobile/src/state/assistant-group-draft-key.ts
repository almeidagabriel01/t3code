import { assistantGroupDraftThreadId } from "@t3tools/client-runtime/assistantGroupChat";
import type { AssistantGroupTabKey } from "@t3tools/client-runtime/assistantGroupChat";
import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";

const LEGACY_GROUP_DRAFT_PREFIX = "assistant-group:";
const OUTGOING_MARKER = ":outgoing:";

/** A group's unsent message, kept under its thread-shaped key like every thread draft. */
export function assistantGroupDraftKey(environmentId: EnvironmentId, teamId: AssistantTeamId) {
  return scopedThreadKey(environmentId, assistantGroupDraftThreadId(teamId));
}

/** The text of a message on its way from one tab, held apart so the tab's draft stays free. */
export function assistantGroupOutgoingDraftKey(
  groupDraftKey: string,
  tab: AssistantGroupTabKey | null,
): string {
  return `${groupDraftKey}${OUTGOING_MARKER}${tab ?? ""}`;
}

/**
 * Moves a draft saved under the old `assistant-group:<env>:<team>` key to the thread-shaped one,
 * and drops the text of messages that were on their way: what tracks them lives in memory only,
 * so after a restart nothing can reach that text again.
 */
export function migratePersistedAssistantGroupDraftKey(key: string): string | null {
  const legacy = key.startsWith(LEGACY_GROUP_DRAFT_PREFIX);
  if (legacy) {
    const rest = key.slice(LEGACY_GROUP_DRAFT_PREFIX.length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return key;
    key = `${rest.slice(0, separator)}:${LEGACY_GROUP_DRAFT_PREFIX}${rest.slice(separator + 1)}`;
  }
  const groupAt = key.indexOf(`:${LEGACY_GROUP_DRAFT_PREFIX}`);
  if (groupAt > 0 && key.includes(OUTGOING_MARKER, groupAt)) return null;
  return key;
}
