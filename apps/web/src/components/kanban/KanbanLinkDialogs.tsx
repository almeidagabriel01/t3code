import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import type { EnvironmentId, KanbanCard, ThreadId } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useQuietThreadShells } from "../../state/entities";
import { useProviderEntry, useThreadCardMap } from "../../state/kanban";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { useKanbanActions, useKanbanStates } from "./useKanban";

const MAX_ROWS = 30;

function PickerDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly emptyLabel: string;
  readonly onClose: () => void;
  readonly children: (query: string) => ReactNode;
  readonly isEmpty: (query: string) => boolean;
}) {
  const [query, setQuery] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Input
              autoFocus
              type="search"
              aria-label="Search"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="grid max-h-80 gap-0.5 overflow-y-auto">
              {props.isEmpty(query) ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  {props.emptyLabel}
                </p>
              ) : (
                props.children(query)
              )}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function PickerRow(props: {
  readonly disabled: boolean;
  readonly onPick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onPick}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  );
}

function ThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly shell: ReturnType<typeof useQuietThreadShells>[number];
  readonly note: string | null;
  readonly onPick: () => void;
}) {
  const { shell } = props;
  const entry = useProviderEntry(props.environmentId, shell.providerInstanceId);
  return (
    <PickerRow disabled={props.note !== null} onPick={props.onPick}>
      {entry ? (
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          acpRegistryAgentId={entry.acpRegistryAgentId}
          acpRegistryIconUrl={entry.acpRegistryIconUrl}
          size="compact"
        />
      ) : (
        <BotIcon className="size-4 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{shell.title}</span>
      {props.note ? (
        <Badge variant="outline" size="sm">
          {props.note}
        </Badge>
      ) : (
        <>
          <Badge variant="secondary" size="sm">
            {shell.runtime?.status ?? "idle"}
          </Badge>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTimeLabel(shell.updatedAt)}
          </span>
        </>
      )}
    </PickerRow>
  );
}

/** Links one of this project's existing threads to the card. */
export function KanbanLinkThreadDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly board: Pick<KanbanBoardState, "projectId">;
  readonly card: KanbanCard;
  readonly onClose: () => void;
}) {
  const actions = useKanbanActions(props.environmentId);
  const shells = useQuietThreadShells();
  const linked = useThreadCardMap(props.environmentId);
  const candidates = shells
    .filter(
      (shell) =>
        shell.environmentId === props.environmentId &&
        shell.projectId === props.board.projectId &&
        shell.archivedAt === null,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const matches = (query: string) => {
    const text = query.trim().toLowerCase();
    return candidates
      .filter((shell) => text === "" || shell.title.toLowerCase().includes(text))
      .slice(0, MAX_ROWS);
  };
  const noteFor = (threadId: ThreadId) => {
    const other = linked?.get(threadId);
    if (other === undefined) return null;
    return other.id === props.card.id ? "Linked" : `On #${other.number}`;
  };
  return (
    <PickerDialog
      title="Link existing thread"
      description={`Pick a thread from this project to link to #${props.card.number}.`}
      emptyLabel="No threads found."
      onClose={props.onClose}
      isEmpty={(query) => matches(query).length === 0}
    >
      {(query) =>
        matches(query).map((shell) => (
          <ThreadRow
            key={shell.id}
            environmentId={props.environmentId}
            shell={shell}
            note={noteFor(shell.id)}
            onPick={async () => {
              if (
                (await actions.linkCardThread({ cardId: props.card.id, threadId: shell.id })) !==
                null
              ) {
                props.onClose();
              }
            }}
          />
        ))
      }
    </PickerDialog>
  );
}

/** Links an existing thread to one of its project's cards. */
export function KanbanLinkCardDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly onClose: () => void;
}) {
  const actions = useKanbanActions(props.environmentId);
  const states = useKanbanStates();
  const state = states.find((entry) => entry.environmentId === props.environmentId)?.state;
  const board =
    state === null || state === undefined
      ? undefined
      : [...state.boards.values()].find((entry) => entry.projectId === props.projectId);
  const cards = board
    ? [...board.cards.values()].toSorted((left, right) => right.number - left.number)
    : [];
  const matches = (query: string) => {
    const text = query.trim().toLowerCase();
    return cards
      .filter((card) => text === "" || `#${card.number} ${card.title}`.toLowerCase().includes(text))
      .slice(0, MAX_ROWS);
  };
  return (
    <PickerDialog
      title="Link to card"
      description="Pick a card on this project's board. This thread then counts as working on it."
      emptyLabel={board ? "No cards found." : "This project has no board yet."}
      onClose={props.onClose}
      isEmpty={(query) => matches(query).length === 0}
    >
      {(query) =>
        matches(query).map((card) => {
          const column = board?.columns.find((entry) => entry.id === card.columnId);
          const already = card.linkedThreadIds.includes(props.threadId);
          return (
            <PickerRow
              key={card.id}
              disabled={already}
              onPick={async () => {
                if (
                  (await actions.linkCardThread({ cardId: card.id, threadId: props.threadId })) !==
                  null
                ) {
                  props.onClose();
                }
              }}
            >
              <span className="w-9 shrink-0 text-xs text-muted-foreground tabular-nums">
                #{card.number}
              </span>
              <span className="min-w-0 flex-1 truncate">{card.title}</span>
              {already ? (
                <Badge variant="outline" size="sm">
                  Linked
                </Badge>
              ) : column ? (
                <span className="shrink-0 text-xs text-muted-foreground">{column.name}</span>
              ) : null}
            </PickerRow>
          );
        })
      }
    </PickerDialog>
  );
}
