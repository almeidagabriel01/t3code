import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type { EnvironmentId, KanbanCard } from "@t3tools/contracts";
import { ArchiveRestoreIcon } from "lucide-react";

import { kanbanEnvironment } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { useKanbanActions } from "./useKanban";

export function KanbanArchive(props: {
  readonly environmentId: EnvironmentId;
  readonly board: KanbanBoardState;
  readonly canEdit: boolean;
  readonly onOpenCard: (card: KanbanCard) => void;
}) {
  const actions = useKanbanActions(props.environmentId);
  const query = useEnvironmentQuery(
    kanbanEnvironment.archived({
      environmentId: props.environmentId,
      input: { boardId: props.board.id },
    }),
  );
  if (query.error !== null) {
    return (
      <p className="p-6 text-sm text-destructive-foreground">Could not load archived cards.</p>
    );
  }
  if (query.data === null) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (query.data.cards.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No archived cards.</p>;
  }
  return (
    <ul className="mx-auto grid max-w-3xl gap-1 p-4">
      {query.data.cards.map((card) => (
        <li key={card.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left hover:underline"
            onClick={() => props.onOpenCard(card)}
          >
            #{card.number} {card.title}
          </button>
          {card.archivedAt ? (
            <span className="text-xs text-muted-foreground">
              {new Date(card.archivedAt).toLocaleDateString()}
            </span>
          ) : null}
          {props.canEdit ? (
            <Button
              size="xs"
              variant="outline"
              onClick={async () => {
                if ((await actions.unarchiveCard({ cardId: card.id })) !== null) query.refresh();
              }}
            >
              <ArchiveRestoreIcon />
              Restore
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
