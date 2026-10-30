import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useDecisionEntries } from "../../state/decisions";
import { cn } from "../../lib/utils";
import { ConnectedDecisionCard } from "./ConnectedDecisionCard";

/** Open decisions as cards, most urgent first, then a folded list of how recent ones ended. */
export function DecisionsSection() {
  const { open, settled } = useDecisionEntries();
  const [recentOpen, setRecentOpen] = useState(false);
  if (open.length === 0 && settled.length === 0) return null;
  return (
    <section aria-label="Decisions" className="flex flex-col gap-2">
      {open.length > 0 ? (
        <>
          <h2 className="px-2 text-xs font-medium text-muted-foreground">
            Decisions ({open.length})
          </h2>
          <ul className="flex flex-col gap-2">
            {open.map((entry) => (
              <li key={`${entry.environmentId}:${entry.decision.id}`}>
                <ConnectedDecisionCard entry={entry} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {settled.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={recentOpen}
            className="flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground outline-hidden hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => setRecentOpen((value) => !value)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", recentOpen && "rotate-90")}
            />
            Recent decisions ({settled.length})
          </button>
          {recentOpen ? (
            <ul className="flex flex-col gap-2 px-2">
              {settled.map((entry) => (
                <li key={`${entry.environmentId}:${entry.decision.id}`}>
                  <ConnectedDecisionCard entry={entry} embedded />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
