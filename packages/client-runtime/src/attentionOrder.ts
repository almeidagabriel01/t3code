import type { AssistantMood } from "./assistantRobot.ts";

/**
 * The one order every list of work shares (assistants, groups, a project's open threads): what
 * waits on the user, then what is working, then the latest activity first.
 */
export type AttentionTier = "needsYou" | "working" | "rest";

export interface AttentionKey {
  readonly tier: AttentionTier;
  /** Epoch ms of the latest activity; 0 when unknown. */
  readonly activityAt: number;
}

const TIER_RANK: Record<AttentionTier, number> = { needsYou: 0, working: 1, rest: 2 };

export function compareAttention(a: AttentionKey, b: AttentionKey): number {
  return TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.activityAt - a.activityAt;
}

/** An assistant's tier from its `assistantStatus` mood; failed or limited waits like idle. */
export const attentionTierOfMood = (mood: AssistantMood): AttentionTier =>
  mood === "needs" ? "needsYou" : mood === "working" ? "working" : "rest";

/** A sorted copy; ties keep the caller's rule, then the input order. */
export function sortByAttention<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => AttentionKey,
  tieBreak: (a: T, b: T) => number = () => 0,
): T[] {
  return items
    .map((item) => ({ item, key: keyOf(item) }))
    .sort((a, b) => compareAttention(a.key, b.key) || tieBreak(a.item, b.item))
    .map(({ item }) => item);
}
