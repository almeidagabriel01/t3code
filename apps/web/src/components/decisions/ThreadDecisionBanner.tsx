import { formatDecisionExpiry } from "@t3tools/client-runtime/state/decisions";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageCircleQuestionMarkIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { useThreadOpenDecisions } from "../../state/decisions";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/button";
import { ConnectedDecisionCard } from "./ConnectedDecisionCard";

/**
 * The thread's most urgent open decision, in the composer's banner stack so the timeline makes
 * room for it. One row until the user reviews it; the rest wait on the Activity page.
 */
export function ThreadDecisionBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  // A provider approval is already shown by the thread's own approval UI.
  const [first, ...rest] = useThreadOpenDecisions(props.environmentId, props.threadId).filter(
    (entry) => entry.decision.approvalRequestId === undefined,
  );
  if (first === undefined) return null;
  return (
    <DecisionBannerRow
      key={`${first.environmentId}:${first.decision.id}`}
      entry={first}
      more={rest.length}
    />
  );
}

function DecisionBannerRow(props: {
  readonly entry: NonNullable<ReturnType<typeof useThreadOpenDecisions>[number]>;
  readonly more: number;
}) {
  const navigate = useNavigate();
  const nowMs = useNowMinuteMs();
  const [expanded, setExpanded] = useState(false);
  const { decision } = props.entry;
  const expiry =
    decision.expiresAt === undefined ? null : formatDecisionExpiry(decision.expiresAt, nowMs);
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant="warning" data-decision-banner>
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <MessageCircleQuestionMarkIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="shrink-0 text-muted-foreground">Decision needed:</span>
            <span className="min-w-0 truncate">{decision.title}</span>
            {expiry ? (
              <>
                <ComposerBanner.Separator />
                <span className="shrink-0 text-muted-foreground">{expiry}</span>
              </>
            ) : null}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {props.more > 0 ? (
              <Button
                variant="ghost-muted"
                size="xs"
                onClick={() => void navigate({ to: "/activity" })}
              >
                +{props.more} more
              </Button>
            ) : null}
            <Button
              size="xs"
              variant={expanded ? "ghost-muted" : "default"}
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Hide" : "Review"}
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {expanded ? (
          <ComposerBanner.Scroll>
            <div className="px-3 pt-1 pb-2">
              <ConnectedDecisionCard entry={props.entry} inThread embedded />
            </div>
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
