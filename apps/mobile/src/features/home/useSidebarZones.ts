import { rankAssistants } from "@t3tools/client-runtime/assistantList";
import {
  assistantIndicator,
  countWaits,
  teamsLayout,
  type ZoneIndicator,
} from "@t3tools/client-runtime/sidebarZones";
import { useMemo } from "react";

import {
  useAssistantEntries,
  useAssistantStatus,
  useThreadOwnership,
} from "../../state/assistants";
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
  const { items, read } = useAssistantStatus();
  return useMemo(() => {
    const assistantIndicators = new Map<string, ZoneIndicator | null>();
    const ranked = rankAssistants(active, shells, (entry, presence) =>
      read(entry.environmentId, entry.assistant.id, presence),
    ).map((item) => {
      const key = assistantKeyOf(item.entry);
      const indicator = assistantIndicator({
        needsYou: countWaits(items, { assistantKeys: new Set([key]) }),
        mood: item.presence.mood,
      });
      assistantIndicators.set(key, indicator);
      return { ...item, key, indicator };
    });
    const layout = teamsLayout({ assistants: ranked, teams: activeTeams, items });
    const folderIndicators = new Map(
      layout.folders.map(
        ({ team, indicator }) => [`${team.environmentId}:${team.team.id}`, indicator] as const,
      ),
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
  }, [shells, items, read, ownerOf, ownedThreadKeys, active, activeTeams]);
}

type SidebarZones = ReturnType<typeof useSidebarZones>;
export type TeamsMember = SidebarZones["layout"]["ungrouped"][number];
