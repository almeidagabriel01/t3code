import {
  describeSettledDecision,
  formatDecisionExpiry,
} from "@t3tools/client-runtime/state/decisions";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type Decision,
} from "@t3tools/contracts";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn, randomUUID } from "../../lib/utils";
import type { DecisionReply } from "../../state/decisions";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

/** Long context folds behind "Show more" instead of pushing the options off screen. */
const CONTEXT_FOLD_LENGTH = 280;

export interface DecisionCardProps {
  readonly decision: Decision;
  /** False when this connection cannot answer: the card still reads, its buttons are off. */
  readonly canAct: boolean;
  readonly onAnswer: (input: {
    optionId?: string;
    text?: string;
    attachments?: ReadonlyArray<ChatImageAttachment | ChatFileAttachment>;
  }) => Promise<DecisionReply>;
  /** Uploads one file ahead of the answer. Omitted where attaching is not possible. */
  readonly onUploadFile?:
    | ((file: File) => Promise<{ readonly attachmentId: string; readonly mimeType: string }>)
    | undefined;
  readonly onDismiss: () => Promise<DecisionReply>;
  /** Opens the requesting thread; omitted where the card already sits in it. */
  readonly onOpenThread?: (() => void) | undefined;
  /** Drops the card's own chrome, for a host that supplies the surface. */
  readonly embedded?: boolean;
}

function Heading(props: { decision: Decision; onOpenThread?: (() => void) | undefined }) {
  const { decision } = props;
  const now = useNowMinuteMs();
  const expiry =
    decision.status === "open" && decision.expiresAt !== undefined
      ? formatDecisionExpiry(decision.expiresAt, now)
      : null;
  return (
    <header className="flex flex-col gap-0.5">
      <h3 className="text-sm font-medium text-foreground">{decision.title}</h3>
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {props.onOpenThread ? (
          <button
            type="button"
            className="min-w-0 cursor-pointer truncate rounded-sm text-left outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={props.onOpenThread}
          >
            {decision.threadTitle}
          </button>
        ) : (
          <span className="min-w-0 truncate">{decision.threadTitle}</span>
        )}
        {expiry ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0">{expiry}</span>
          </>
        ) : null}
      </p>
    </header>
  );
}

function Context(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (props.text.trim() === "") return null;
  const foldable = props.text.length > CONTEXT_FOLD_LENGTH || props.text.split("\n").length > 5;
  return (
    <div className="flex flex-col items-start gap-1">
      <div className={cn("min-w-0 text-sm", foldable && !expanded && "max-h-24 overflow-hidden")}>
        <ChatMarkdown text={props.text} cwd={undefined} className="text-foreground/85" />
      </div>
      {foldable ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="cursor-pointer rounded-sm text-xs text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function SettledCard(props: DecisionCardProps) {
  const { outcome, detail } = describeSettledDecision(props.decision);
  return (
    <div className="flex flex-col gap-1">
      <Heading decision={props.decision} onOpenThread={props.onOpenThread} />
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{outcome}</span>
        {detail ? ` · ${detail}` : null}
      </p>
    </div>
  );
}

type PickedFile = {
  readonly key: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly status: "uploading" | "ready" | "failed";
  readonly attachment?: ChatImageAttachment | ChatFileAttachment;
  readonly error?: string;
};

function AttachmentStrip(props: {
  files: ReadonlyArray<PickedFile>;
  onRemove: (key: string) => void;
}) {
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {props.files.map((file) => (
        <li
          key={file.key}
          className="flex max-w-full items-center gap-1.5 rounded-md border border-foreground/12 bg-foreground/5 py-0.5 pr-0.5 pl-2 text-xs"
        >
          {file.status === "uploading" ? <Spinner size="xs" tone="muted" /> : null}
          <span
            className={cn(
              "min-w-0 truncate",
              file.status === "failed" && "text-destructive-foreground",
            )}
          >
            {file.name}
            {file.status === "failed" ? " (upload failed)" : null}
          </span>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={`Remove ${file.name}`}
            onClick={() => props.onRemove(file.key)}
          >
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function OpenCard(props: DecisionCardProps) {
  const { decision } = props;
  const [optionId, setOptionId] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"answer" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ReadonlyArray<PickedFile>>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const text = note.trim();
  const attachments = files.flatMap((file) => (file.attachment ? [file.attachment] : []));
  const uploading = files.some((file) => file.status === "uploading");
  const ready = optionId !== null || text !== "" || attachments.length > 0;
  const off = !props.canAct || busy !== null;
  // An approval mirror has no channel for files.
  const canAttach = props.onUploadFile !== undefined && decision.approvalRequestId === undefined;

  const patchFile = (key: string, patch: Partial<PickedFile>) =>
    setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...patch } : file)));

  const pick = (picked: ReadonlyArray<File>) => {
    const upload = props.onUploadFile;
    if (!upload) return;
    const room = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - files.length);
    const next = picked.slice(0, room).map((file) => ({
      file,
      key: randomUUID(),
    }));
    setFiles((current) => [
      ...current,
      ...next.map(({ file, key }): PickedFile => ({
        key,
        name: file.name || "file",
        sizeBytes: file.size,
        status: "uploading",
      })),
    ]);
    for (const { file, key } of next) {
      upload(file).then(
        ({ attachmentId, mimeType }) =>
          patchFile(key, {
            status: "ready",
            attachment: {
              type: mimeType.startsWith("image/") ? "image" : "file",
              id: attachmentId,
              name: file.name || "file",
              mimeType,
              sizeBytes: file.size,
            } as ChatImageAttachment | ChatFileAttachment,
          }),
        (cause: unknown) =>
          patchFile(key, {
            status: "failed",
            error: cause instanceof Error ? cause.message : "Upload failed",
          }),
      );
    }
  };

  const run = async (kind: "answer" | "dismiss") => {
    setBusy(kind);
    setError(null);
    const reply =
      kind === "answer"
        ? await props.onAnswer({
            ...(optionId === null ? {} : { optionId }),
            ...(text === "" ? {} : { text }),
            ...(attachments.length === 0 ? {} : { attachments }),
          })
        : await props.onDismiss();
    setBusy(null);
    // The settled decision arrives on the stream and replaces this card; a refusal stays here.
    if (!reply.ok) setError(reply.message);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Embedded in the thread banner, whose row already names it and its expiry. */}
      {props.embedded ? null : <Heading decision={decision} onOpenThread={props.onOpenThread} />}
      <Context text={decision.context} />
      <RadioGroup
        aria-label="Options"
        value={optionId ?? ""}
        onValueChange={(value) => setOptionId(value === "" ? null : String(value))}
      >
        {decision.options.map((option) => (
          <label
            key={option.id}
            className={cn(
              "flex items-start gap-2.5 rounded-md px-2 py-1.5 outline-hidden hover:bg-foreground/8",
              off ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
          >
            <Radio value={option.id} disabled={off} className="mt-0.5" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-1.5 text-sm">
                {option.label}
                {decision.recommended === option.id ? (
                  <Badge variant="info" size="sm">
                    Recommended
                  </Badge>
                ) : null}
              </span>
              {option.consequence ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {option.consequence}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </RadioGroup>
      {noteOpen ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`decision-note-${decision.id}`}>Other answer or note</Label>
          <Textarea
            id={`decision-note-${decision.id}`}
            value={note}
            disabled={off}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      ) : (
        <button
          type="button"
          className="w-fit cursor-pointer rounded-sm text-xs text-foreground/75 underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setNoteOpen(true)}
        >
          Other answer or add a note
        </button>
      )}
      {canAttach ? (
        <div className="flex flex-col gap-1.5">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="Choose files to attach"
            onChange={(event) => {
              pick([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <Button
            variant="ghost-muted"
            size="xs"
            className="w-fit"
            disabled={off || files.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS}
            onClick={() => fileInput.current?.click()}
          >
            <PaperclipIcon />
            Attach files
          </Button>
          {files.length > 0 ? (
            <AttachmentStrip
              files={files}
              onRemove={(key) => setFiles((current) => current.filter((file) => file.key !== key))}
            />
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost-muted" size="sm" disabled={off} onClick={() => void run("dismiss")}>
          Dismiss
        </Button>
        <Button size="sm" disabled={off || !ready || uploading} onClick={() => void run("answer")}>
          {busy === "answer" ? "Answering…" : "Answer"}
        </Button>
      </div>
    </div>
  );
}

/** One decision an agent put to the user: answer it, dismiss it, or read how it ended. */
export function DecisionCard(props: DecisionCardProps) {
  return (
    <article
      aria-label={props.decision.title}
      data-decision-card={props.decision.status}
      className={cn(
        "@container w-full min-w-0",
        !props.embedded &&
          "surface-glass rounded-xl border border-foreground/12 p-3 shadow-xs @2xl:p-4",
      )}
    >
      {props.decision.status === "open" ? <OpenCard {...props} /> : <SettledCard {...props} />}
    </article>
  );
}
