import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type { EnvironmentId, KanbanCard } from "@t3tools/contracts";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";

import { kanbanEnvironment } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
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
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ArchiveIcon />
          </EmptyMedia>
          <EmptyTitle>No archived cards</EmptyTitle>
          <EmptyDescription>Archived cards leave the board and show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="mx-auto grid max-w-3xl gap-1 p-4">
      {query.data.cards.map((card) => (
        <li
          key={card.id}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm"
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left hover:underline"
            onClick={() => props.onOpenCard(card)}
          >
            <span className="text-muted-foreground tabular-nums">#{card.number}</span> {card.title}
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
