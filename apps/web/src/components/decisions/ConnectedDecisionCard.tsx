import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DecisionEntry } from "@t3tools/client-runtime/state/decisions";
import { useNavigate } from "@tanstack/react-router";

import {
  discardStandaloneAttachment,
  uploadStandaloneAttachment,
} from "../../lib/attachmentUploadQueue";
import { useDecisionActions } from "../../state/decisions";
import { buildThreadRouteParams } from "../../threadRoutes";
import { DecisionCard } from "./DecisionCard";

/** A decision wired to its environment: answers and dismissals go to the server that asked. */
export function ConnectedDecisionCard(props: {
  readonly entry: DecisionEntry;
  /** Hide the link to the requesting thread where the card already sits in it. */
  readonly inThread?: boolean;
  readonly embedded?: boolean;
}) {
  const { environmentId, decision } = props.entry;
  const navigate = useNavigate();
  const actions = useDecisionActions(environmentId);
  return (
    <DecisionCard
      decision={decision}
      canAct={actions.canAct}
      onAnswer={(input) => actions.answer(decision.id, input)}
      onDismiss={() => actions.dismiss(decision.id)}
      onUploadFile={(file) => uploadStandaloneAttachment(environmentId, file)}
      onDiscardFile={(attachmentId) => discardStandaloneAttachment(environmentId, attachmentId)}
      embedded={props.embedded ?? false}
      onOpenThread={
        props.inThread
          ? undefined
          : () =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(environmentId, decision.fromThreadId),
                ),
              })
      }
    />
  );
}
