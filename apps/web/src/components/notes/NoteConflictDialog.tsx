import { diffNoteLines, type NoteDiffLine } from "@t3tools/client-runtime/notes/line-diff";

import { cn } from "../../lib/utils";
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
import type { NoteEditState } from "./noteState";

function DiffColumn(props: { label: string; lines: ReadonlyArray<NoteDiffLine> }) {
  return (
    <section className="grid min-w-0 content-start gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{props.label}</h3>
      <pre
        aria-label={props.label}
        className="max-h-80 min-h-24 overflow-auto rounded-lg border border-border bg-muted/30 py-2 font-mono text-xs leading-5"
      >
        {props.lines.map((line, index) => (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- lines repeat, so their position is their identity
            key={index}
            data-change={line.kind}
            className={cn(
              "px-3 break-words whitespace-pre-wrap",
              line.kind === "added" && "bg-success/12 text-success-foreground",
              line.kind === "removed" && "bg-destructive/12 text-destructive-foreground",
            )}
          >
            {line.text || " "}
          </div>
        ))}
      </pre>
    </section>
  );
}

/** Shows the file as it is now beside the draft, and lets the person keep either one. */
export function NoteConflictDialog(props: {
  state: NoteEditState;
  open: boolean;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  onTheirs: () => void;
  onMine: () => void;
}) {
  const incoming = props.state.incoming;
  const open = props.open && incoming !== null;
  // Bounded by diffNoteLines, so computing it while open is cheap enough to skip caching.
  const diff = open ? diffNoteLines(props.state.body, incoming.body) : null;
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>This note changed</DialogTitle>
          <DialogDescription>
            Someone or something else saved this note while you were editing. Keep your draft to
            save it over the current file, or use the current file and drop your draft.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {diff ? (
            <div className="grid gap-3 md:grid-cols-2">
              <DiffColumn label="Current file" lines={diff.server} />
              <DiffColumn label="Your draft" lines={diff.local} />
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={props.state.saving} onClick={props.onTheirs}>
            Use current file
          </Button>
          <Button disabled={!props.canWrite || props.state.saving} onClick={props.onMine}>
            Keep my draft
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
