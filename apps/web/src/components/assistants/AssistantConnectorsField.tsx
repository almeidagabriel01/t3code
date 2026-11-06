import {
  CONNECTOR_TRANSPORT_LABELS,
  CONNECTORS_PROVIDER_NOTE,
  connectorDraftsProblem,
  emptyConnectorDraft,
  newConnectorRow,
  type ConnectorDraft,
  type ConnectorRowDraft,
} from "@t3tools/client-runtime/assistantConnectors";
import { PencilIcon, PlugIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

function RowsEditor(props: {
  readonly label: string;
  readonly addLabel: string;
  readonly keyLabel: string;
  readonly rows: ReadonlyArray<ConnectorRowDraft>;
  readonly onChange: (rows: ReadonlyArray<ConnectorRowDraft>) => void;
}) {
  const patch = (index: number, next: Partial<ConnectorRowDraft>) =>
    props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...next } : row)));
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">{props.label}</legend>
      <p className="text-xs text-muted-foreground">
        Values are stored on the server and never shown again. Leave a saved value empty to keep it.
      </p>
      {props.rows.map((row, index) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            aria-label={`${props.keyLabel} ${index + 1}`}
            placeholder={props.keyLabel}
            value={row.key}
            onChange={(event) => patch(index, { key: event.target.value })}
          />
          <Input
            type="password"
            autoComplete="off"
            aria-label={`${props.keyLabel} ${index + 1} value`}
            placeholder={row.saved ? "Saved" : "Value"}
            value={row.value}
            onChange={(event) => patch(index, { value: event.target.value })}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Remove ${props.keyLabel.toLowerCase()} ${index + 1}`}
            onClick={() => props.onChange(props.rows.filter((_, i) => i !== index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="self-start"
        onClick={() => props.onChange([...props.rows, newConnectorRow()])}
      >
        <PlusIcon />
        {props.addLabel}
      </Button>
    </fieldset>
  );
}

function ConnectorForm(props: {
  readonly draft: ConnectorDraft;
  readonly isNew: boolean;
  readonly onChange: (patch: Partial<ConnectorDraft>) => void;
}) {
  const { draft } = props;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="connector-name">Connector name</Label>
        <p className="text-xs text-muted-foreground">
          {props.isNew
            ? "Lowercase letters, numbers, dashes or underscores. Its tools are prefixed with it."
            : "A name cannot change once saved, because saved values belong to it."}
        </p>
        <Input
          id="connector-name"
          value={draft.name}
          disabled={!props.isNew}
          onChange={(event) => props.onChange({ name: event.target.value.toLowerCase() })}
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Type</legend>
        <RadioGroup
          aria-label="Connector type"
          value={draft.transport}
          onValueChange={(value) =>
            props.onChange({ transport: value as ConnectorDraft["transport"] })
          }
        >
          {(["http", "stdio"] as const).map((transport) => (
            <label
              key={transport}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm outline-hidden hover:bg-foreground/8"
            >
              <Radio value={transport} />
              {transport === "http" ? "HTTP server (URL)" : "Command (runs on this machine)"}
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {draft.transport === "http" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connector-url">URL</Label>
            <Input
              id="connector-url"
              placeholder="https://example.com/mcp"
              value={draft.url}
              onChange={(event) => props.onChange({ url: event.target.value })}
            />
          </div>
          <RowsEditor
            label="Headers"
            addLabel="Add header"
            keyLabel="Header"
            rows={draft.headers}
            onChange={(headers) => props.onChange({ headers })}
          />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connector-command">Command</Label>
            <Input
              id="connector-command"
              placeholder="npx"
              value={draft.command}
              onChange={(event) => props.onChange({ command: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connector-args">Arguments</Label>
            <p className="text-xs text-muted-foreground">One per line.</p>
            <Textarea
              id="connector-args"
              rows={3}
              value={draft.args}
              onChange={(event) => props.onChange({ args: event.target.value })}
            />
          </div>
          <RowsEditor
            label="Environment variables"
            addLabel="Add variable"
            keyLabel="Variable"
            rows={draft.env}
            onChange={(env) => props.onChange({ env })}
          />
        </>
      )}
    </div>
  );
}

/** The assistant's own MCP servers; edits stay in the draft until the assistant is saved. */
export function AssistantConnectorsField(props: {
  readonly value: ReadonlyArray<ConnectorDraft>;
  readonly onChange: (next: ReadonlyArray<ConnectorDraft>) => void;
}) {
  // index -1 is a connector being added.
  const [editing, setEditing] = useState<{ index: number; draft: ConnectorDraft } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const commit = () => {
    if (editing === null) return;
    const next =
      editing.index === -1
        ? [...props.value, editing.draft]
        : props.value.map((entry, i) => (i === editing.index ? editing.draft : entry));
    const found = connectorDraftsProblem(next);
    if (found !== null) return setProblem(found);
    props.onChange(next);
    setEditing(null);
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">Connectors</legend>
      <p className="text-xs text-muted-foreground">
        MCP servers only this assistant gets, next to T3's own tools. {CONNECTORS_PROVIDER_NOTE}
      </p>
      {props.value.map((connector, index) => (
        <div
          key={connector.name}
          className="flex items-center justify-between gap-2 rounded-md border border-foreground/12 px-2.5 py-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <PlugIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{connector.name}</span>
            <span className="text-xs text-muted-foreground">
              {CONNECTOR_TRANSPORT_LABELS[connector.transport]}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Switch
              checked={connector.enabled}
              aria-label={`${connector.name} enabled`}
              onCheckedChange={(checked) =>
                props.onChange(
                  props.value.map((entry, i) =>
                    i === index ? { ...entry, enabled: Boolean(checked) } : entry,
                  ),
                )
              }
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={`Edit ${connector.name}`}
              onClick={() => {
                setProblem(null);
                setEditing({ index, draft: connector });
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-destructive"
              aria-label={`Remove ${connector.name}`}
              onClick={() => props.onChange(props.value.filter((_, i) => i !== index))}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="self-start"
        onClick={() => {
          setProblem(null);
          setEditing({ index: -1, draft: emptyConnectorDraft() });
        }}
      >
        <PlusIcon />
        Add connector
      </Button>
      {editing === null ? null : (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogPopup className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editing.index === -1 ? "Add connector" : "Edit connector"}</DialogTitle>
              <DialogDescription>
                Applies to this assistant's next session, once you save the assistant.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <ConnectorForm
                draft={editing.draft}
                isNew={editing.index === -1}
                onChange={(patch) =>
                  setEditing({ ...editing, draft: { ...editing.draft, ...patch } })
                }
              />
              {problem ? (
                <Alert variant="error" className="mt-4">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              ) : null}
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={commit}>
                {editing.index === -1 ? "Add" : "Done"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </fieldset>
  );
}
