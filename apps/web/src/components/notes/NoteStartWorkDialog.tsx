import { useAtomValue } from "@effect/atom-react";
import { selectKanbanBoardByProject } from "@t3tools/client-runtime/state/kanban";
import type {
  EnvironmentId,
  KanbanColumnId,
  NoteDocument,
  NotesStartWorkResult,
  ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { BotIcon, ExternalLinkIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { kanbanEnvironment } from "../../state/kanban";
import { notesEnvironment } from "../../state/notes";
import { KanbanStartAgentDialog } from "../kanban/KanbanStartAgent";
import { OptionSelect } from "../kanban/kanbanDialogs";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { useNoteCard, useOpenKanbanCard } from "./NoteCard";
import { noteErrorMessage } from "./noteState";
import { defaultWorkProject, workProjectOptions } from "@t3tools/client-runtime/notes/work";
import { useNoteCommand } from "./useNoteCommand";

const DEFAULT_COLUMN = "";

function StartedCard(props: {
  environmentId: EnvironmentId;
  result: NotesStartWorkResult;
  projectId: ProjectId;
  onClose: () => void;
}) {
  const card = useNoteCard(props.environmentId, {
    cardId: props.result.cardId,
    projectId: props.projectId,
  });
  const openCard = useOpenKanbanCard();
  const [startingAgent, setStartingAgent] = useState(false);
  const found = card.status === "found" ? card : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Card created</DialogTitle>
        <DialogDescription>
          The note is now linked to its card. Open the card, or start an agent on it right away.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm">
          {found ? (
            <>
              <span className="font-medium tabular-nums">#{found.card.number}</span>
              <span className="min-w-0 flex-1 truncate">{found.card.title}</span>
              {found.columnName ? (
                <span className="shrink-0 text-xs text-muted-foreground">{found.columnName}</span>
              ) : null}
            </>
          ) : (
            <span role="status" className="flex items-center gap-2 text-muted-foreground">
              <Spinner />
              Loading the card…
            </span>
          )}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="ghost" onClick={props.onClose}>
          Done
        </Button>
        <Button
          variant="outline"
          disabled={found === null}
          onClick={() => {
            if (found === null) return;
            props.onClose();
            openCard(props.environmentId, found.card, props.projectId);
          }}
        >
          <ExternalLinkIcon />
          Open card
        </Button>
        <Button disabled={found === null} onClick={() => setStartingAgent(true)}>
          <BotIcon />
          Start agent
        </Button>
      </DialogFooter>
      {startingAgent && found ? (
        <KanbanStartAgentDialog
          environmentId={props.environmentId}
          board={found.board}
          cards={[found.card]}
          onClose={() => {
            setStartingAgent(false);
            props.onClose();
          }}
        />
      ) : null}
    </>
  );
}

/** Creates one kanban card from the note in a chosen project, then offers to open it or start an agent. */
export function NoteStartWorkDialog(props: {
  environmentId: EnvironmentId;
  document: NoteDocument;
  onStarted: (note: NoteDocument) => void;
  onClose: () => void;
}) {
  const startWork = useNoteCommand(notesEnvironment.startWork);
  const canStart = useAtomValue(notesEnvironment.startWork.permissionAtom(props.environmentId));
  // One id per dialog: a retry after a lost response returns the card instead of a second one.
  const [requestId] = useState(randomUUID);
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const recent = useQuietThreadShells()
    .filter((thread) => thread.environmentId === props.environmentId)
    .toSorted((left, right) =>
      (right.latestUserMessageAt ?? right.updatedAt).localeCompare(
        left.latestUserMessageAt ?? left.updatedAt,
      ),
    )
    .map((thread) => thread.projectId);
  const [pickedProject, setPickedProject] = useState<ProjectId | null>(null);
  const noteProject = projects.find((project) => project.id === props.document.project)?.id;
  const projectId =
    pickedProject ??
    noteProject ??
    defaultWorkProject(projects, props.document.folder, recent) ??
    null;
  const [columnId, setColumnId] = useState<string>(DEFAULT_COLUMN);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    value: NotesStartWorkResult;
    projectId: ProjectId;
  } | null>(null);
  const kanban = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(kanbanEnvironment.live({ environmentId: props.environmentId, input: null })),
    ),
  );
  const board =
    kanban !== null && projectId !== null
      ? selectKanbanBoardByProject(kanban, projectId)
      : undefined;
  const columns = board?.columns ?? [];
  const options = workProjectOptions(projects);

  const start = async () => {
    if (busy || projectId === null || !canStart) return;
    setBusy(true);
    setAttempted(true);
    setError(null);
    const reply = await startWork({
      environmentId: props.environmentId,
      input: {
        path: props.document.path,
        projectId,
        requestId,
        ...(columnId === DEFAULT_COLUMN ? {} : { columnId: columnId as KanbanColumnId }),
      },
    });
    setBusy(false);
    if (reply.ok) {
      setResult({ value: reply.value, projectId });
      props.onStarted(reply.value.note);
    } else {
      setError(noteErrorMessage(reply.error));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!busy}>
        {result ? (
          <StartedCard
            environmentId={props.environmentId}
            result={result.value}
            projectId={result.projectId}
            onClose={props.onClose}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Start work</DialogTitle>
              <DialogDescription>
                Creates a card from “{props.document.title}” on the project’s board, with the note
                as its description, and links the two.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="grid gap-4">
                <div className="flex items-center justify-between gap-3">
                  <Label>Project</Label>
                  {projectId !== null ? (
                    <OptionSelect
                      label="Project"
                      value={projectId}
                      disabled={busy || attempted}
                      options={options}
                      onChange={(value) => {
                        setPickedProject(value);
                        setColumnId(DEFAULT_COLUMN);
                      }}
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">No projects here yet</span>
                  )}
                </div>
                {columns.length > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <Label>Column</Label>
                    <OptionSelect
                      label="Column"
                      value={columnId}
                      disabled={busy || attempted}
                      options={[
                        { value: DEFAULT_COLUMN, label: "Default column" },
                        ...columns.map((column) => ({ value: column.id, label: column.name })),
                      ]}
                      onChange={setColumnId}
                    />
                  </div>
                ) : null}
                {error ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {error}
                  </p>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" disabled={busy} onClick={props.onClose}>
                Cancel
              </Button>
              <Button disabled={busy || projectId === null || !canStart} onClick={start}>
                {busy ? <Spinner /> : <PlayIcon />}
                {attempted && !busy ? "Try again" : "Start work"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
