import { rankAssistants } from "@t3tools/client-runtime/assistantList";
import {
  assistantIndicator,
  countWaits,
  folderIndicator,
  needsYouItems,
  teamsLayout,
  type ZoneIndicator,
} from "@t3tools/client-runtime/sidebarZones";
import { useMemo } from "react";

import { useAssistantEntries, useThreadOwnership } from "../../state/assistants";
import { useDecisionEntries } from "../../state/decisions";
import { useQuietThreadShells } from "../../state/entities";

const assistantKeyOf = (entry: {
  readonly environmentId: string;
  readonly assistant: { readonly id: string };
}) => `${entry.environmentId}:${entry.assistant.id}`;

/**
 * The sidebar's three zones, derived once per section from the shared state: Needs you items,
 * thread ownership, the Teams layout and every indicator. Rows get their slice as plain props.
 */
export function useSidebarZones() {
  const shells = useQuietThreadShells();
  const { active, activeTeams } = useAssistantEntries();
  const { ownerOf, ownedThreadKeys } = useThreadOwnership();
  const { open: decisions } = useDecisionEntries();
  return useMemo(() => {
    const items = needsYouItems({ shells: shells, decisions, ownerOf });
    const waits = (assistantKeys: ReadonlySet<string>, teamKey?: string) =>
      countWaits(items, teamKey === undefined ? { assistantKeys } : { assistantKeys, teamKey });
    const assistantIndicators = new Map<string, ZoneIndicator | null>();
    const ranked = rankAssistants(active, shells).map((item) => {
      const key = assistantKeyOf(item.entry);
      const indicator = assistantIndicator({
        needsYou: waits(new Set([key])),
        mood: item.presence.mood,
      });
      assistantIndicators.set(key, indicator);
      return { ...item, key, indicator };
    });
    // Waiting on the user, then working, then the rest by activity: the order the indicators show.
    const order = (indicator: ZoneIndicator | null) =>
      indicator?.kind === "needs" ? 0 : indicator?.kind === "running" ? 1 : 2;
    const ordered = [...ranked].sort((a, b) => order(a.indicator) - order(b.indicator));
    const layout = teamsLayout({ assistants: ordered, teams: activeTeams });
    const folderIndicators = new Map(
      layout.folders.map(({ team, members }) => {
        const teamKey = `${team.environmentId}:${team.team.id}`;
        return [
          teamKey,
          folderIndicator({
            needsYou: waits(new Set(members.map((member) => member.key)), teamKey),
            members: members.map((member) => ({ mood: member.presence.mood })),
            chat: team.team.chat ?? null,
          }),
        ] as const;
      }),
    );
    return {
      items,
      ownerOf,
      ownedThreadKeys,
      layout,
      indicators: { assistant: assistantIndicators, folder: folderIndicators },
      /** Nothing for the Needs you and Teams zones to draw. */
      empty: items.length === 0 && active.length === 0 && activeTeams.length === 0,
    };
  }, [shells, decisions, ownerOf, ownedThreadKeys, active, activeTeams]);
}

type SidebarZones = ReturnType<typeof useSidebarZones>;
export type TeamsMember = SidebarZones["layout"]["ungrouped"][number];
