import {
  AUTONOMY_WATCH_EVENT_LABELS,
  AUTONOMY_WATCH_PR_EVENTS,
  EMPTY_WATCH_DRAFT,
  watchDraftFromWatch,
  watchInputFromDraft,
  watchSummary,
  type AutonomyWatchDraft,
} from "@t3tools/client-runtime/autonomy";
import {
  AUTONOMY_WATCH_EVENTS,
  AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH,
  type AssistantId,
  type AutonomyWatch,
  type AutonomyWatchEvent,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { EyeIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useAutonomyWatches, useAutonomyWatchActions } from "../../state/autonomyWatches";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

const ALL_PROJECTS = "all";

function WatchForm(props: {
  readonly draft: AutonomyWatchDraft;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly label: string }>;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onChange: (patch: Partial<AutonomyWatchDraft>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  const projectLabel =
    props.projects.find((project) => project.id === draft.projectId)?.label ?? "All projects";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-foreground/12 p-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="watch-title">Title</Label>
        <Input
          id="watch-title"
          value={draft.title}
          maxLength={120}
          onChange={(event) => props.onChange({ title: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="watch-event">Wake it when</Label>
        <Select
          value={draft.event}
          onValueChange={(event) => props.onChange({ event: event as AutonomyWatchEvent })}
        >
          <SelectTrigger id="watch-event" aria-label="Wake it when">
            <SelectValue>{AUTONOMY_WATCH_EVENT_LABELS[draft.event]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {AUTONOMY_WATCH_EVENTS.map((event) => (
              <SelectItem hideIndicator key={event} value={event}>
                {AUTONOMY_WATCH_EVENT_LABELS[event]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="watch-project">Project</Label>
        <Select
          value={draft.projectId ?? ALL_PROJECTS}
          onValueChange={(next) =>
            props.onChange({ projectId: next === ALL_PROJECTS ? null : (next as ProjectId) })
          }
        >
          <SelectTrigger id="watch-project" aria-label="Project">
            <SelectValue>{projectLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={ALL_PROJECTS}>
              All projects
            </SelectItem>
            {props.projects.map((project) => (
              <SelectItem hideIndicator key={project.id} value={project.id}>
                {project.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {AUTONOMY_WATCH_PR_EVENTS.includes(draft.event) ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="watch-pr">PR number</Label>
          <Input
            id="watch-pr"
            inputMode="numeric"
            placeholder="Any pull request"
            value={draft.prNumber}
            onChange={(event) => props.onChange({ prNumber: event.target.value })}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="watch-instruction">What it should do</Label>
        <Textarea
          id="watch-instruction"
          rows={3}
          value={draft.instruction}
          maxLength={AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH}
          onChange={(event) => props.onChange({ instruction: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="watch-expires">Expires</Label>
        <Input
          id="watch-expires"
          type="datetime-local"
          value={draft.expiresAt}
          onChange={(event) => props.onChange({ expiresAt: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">Leave empty to keep watching.</p>
      </div>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <Checkbox
          checked={draft.oneShot}
          aria-label="Only once"
          onCheckedChange={(on) => props.onChange({ oneShot: Boolean(on) })}
        />
        Only once
      </label>
      {props.error ? (
        <Alert variant="error">
          <AlertDescription>{props.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="button" size="xs" disabled={props.saving} onClick={props.onSave}>
          Save watch
        </Button>
      </div>
    </div>
  );
}

/** The watches that wake this assistant, next to its schedules. */
export function AssistantWatches(props: {
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
  readonly notifies: boolean;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly label: string }>;
}) {
  const query = useAutonomyWatches(props.environmentId);
  const actions = useAutonomyWatchActions(props.environmentId);
  const [draft, setDraft] = useState<AutonomyWatchDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const watches = (query.data?.watches ?? []).filter(
    (watch) => (watch.assistantId as string) === props.assistantId,
  );
  const projectTitle = (id: ProjectId) =>
    props.projects.find((project) => project.id === id)?.label ?? null;

  const run = async (title: string, work: () => ReturnType<typeof actions.save>) => {
    if (busy) return null;
    setBusy(true);
    const reply = await work();
    setBusy(false);
    if (!reply.ok)
      toastManager.add(stackedThreadToast({ type: "error", title, description: reply.message }));
    return reply;
  };
  const save = async () => {
    if (draft === null) return;
    const built = watchInputFromDraft(props.assistantId, draft);
    if (!built.ok) return setError(built.message);
    setError(null);
    setBusy(true);
    const reply = await actions.save(built.input);
    setBusy(false);
    if (!reply.ok) return setError(reply.message);
    setDraft(null);
  };
  const remove = async (watch: AutonomyWatch) => {
    const confirmed = await requestConfirmDialog(
      `Delete the watch "${watch.title}"?\nIt stops immediately.`,
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    await run("Could not delete the watch", () => actions.remove(watch.id));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Watches</span>
          <p className="text-xs text-muted-foreground">
            Wake this assistant when something happens, e.g. CI fails on a PR.
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!actions.canAct || draft !== null}
          onClick={() => {
            setError(null);
            setDraft(EMPTY_WATCH_DRAFT);
          }}
        >
          <PlusIcon />
          New watch
        </Button>
      </div>
      {props.notifies ? null : (
        <p className="text-xs text-muted-foreground">
          Watches only wake it when its notifications are on.
        </p>
      )}
      {draft !== null ? (
        <WatchForm
          draft={draft}
          projects={props.projects}
          saving={busy}
          error={error}
          onChange={(patch) =>
            setDraft((current) => (current ? { ...current, ...patch } : current))
          }
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : query.error !== null ? (
        <p className="text-xs text-destructive-foreground">Could not load watches: {query.error}</p>
      ) : watches.length === 0 ? (
        <p className="rounded-md px-2 py-1.5 text-xs text-muted-foreground">
          No watches yet. A watch wakes this assistant when an event you pick happens.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {watches.map((watch) => (
            <li key={watch.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <EyeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{watch.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {watchSummary(watch, projectTitle)}
                  {" · "}
                  {watch.lastTriggeredAt === null
                    ? "Never triggered"
                    : `Last triggered ${formatRelativeTimeLabel(watch.lastTriggeredAt)}`}
                </span>
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Edit ${watch.title}`}
                disabled={!actions.canAct}
                onClick={() => {
                  setError(null);
                  setDraft(watchDraftFromWatch(watch));
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Delete ${watch.title}`}
                disabled={!actions.canAct || busy}
                onClick={() => void remove(watch)}
              >
                <Trash2Icon />
              </Button>
              <Switch
                checked={watch.enabled}
                disabled={!actions.canAct || busy}
                aria-label={watch.enabled ? `Pause ${watch.title}` : `Resume ${watch.title}`}
                onCheckedChange={(enabled) =>
                  void run("Could not update the watch", () =>
                    actions.setEnabled(watch.id, enabled),
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
