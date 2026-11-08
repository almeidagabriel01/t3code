import { useAtomValue } from "@effect/atom-react";
import { t3McpProviderName, type EnvironmentId, type T3McpServer } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  draftFor,
  serverFromDraft,
  supportedProviders,
  type Draft,
} from "@t3tools/client-runtime/mcpServerDrafts";

export function McpServersSettings() {
  const { environment, scope } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const projectScoped = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsSection {...searchableSetting("mcp-servers")}>
      {connected && environment ? (
        <ServerList
          key={environment.environmentId}
          environmentId={environment.environmentId}
          projectScoped={projectScoped}
        />
      ) : (
        <SettingsRow
          title="MCP servers"
          description="Connect an environment to manage its MCP servers."
        />
      )}
    </SettingsSection>
  );
}

function ServerList({
  environmentId,
  projectScoped,
}: {
  environmentId: EnvironmentId;
  projectScoped: boolean;
}) {
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.mcpServers);
  const canWrite =
    useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId)) && !projectScoped;
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editing, setEditing] = useState<{ name?: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (name: string, server: T3McpServer | null) => {
    if (!canWrite || pending) return false;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { patch: { mcpServers: { [name]: server } } },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return false;
    }
    return true;
  };
  return (
    <>
      {projectScoped ? (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Environment-wide setting. Select an environment to change it.
        </p>
      ) : null}
      <SettingsRow
        title="Manage servers"
        description="Servers are available to agent sessions on this environment. OpenCode, Pi, and Muse do not support MCP servers added here."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite || pending}
            onClick={() => setEditing({})}
          >
            Add server
          </Button>
        }
      />
      {Object.entries(servers ?? {}).map(([name, server]) => (
        <SettingsRow
          key={name}
          title={name}
          description={
            <span>
              {server.transport} ·{" "}
              {server.transport === "stdio" ? server.command : new URL(server.url).origin}
              <br />
              Agents see it as {t3McpProviderName(name)} · {supportedProviders(server.transport)}
            </span>
          }
          control={
            <div className="flex items-center gap-2">
              <Switch
                aria-label={`Enable ${name}`}
                checked={server.enabled}
                disabled={!canWrite || pending}
                onCheckedChange={(enabled) => void save(name, { ...server, enabled })}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite || pending}
                onClick={() => setEditing({ name })}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite || pending}
                onClick={() => setRemoving(name)}
              >
                Remove
              </Button>
            </div>
          }
        />
      ))}
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {editing !== null ? (
        <ServerDialog
          key={editing.name ?? "new"}
          originalName={editing.name}
          existing={editing.name ? servers?.[editing.name] : undefined}
          names={new Set(Object.keys(servers ?? {}))}
          pending={pending}
          serverError={error}
          save={save}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the server and its stored secrets from this environment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (removing)
                  void save(removing, null).then((ok) => {
                    if (ok) setRemoving(null);
                  });
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ServerDialog({
  originalName,
  existing,
  names,
  pending,
  serverError,
  save,
  onClose,
}: {
  originalName: string | undefined;
  existing: T3McpServer | undefined;
  names: ReadonlySet<string>;
  pending: boolean;
  serverError: string | null;
  save: (name: string, server: T3McpServer) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFor(originalName, existing));
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const submit = async () => {
    const result = serverFromDraft(draft, names, originalName);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    if (await save(result.name, result.server)) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
          <DialogDescription>Changes apply to new agent sessions.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="mcp-server-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={draft.name}
                disabled={!!existing}
                onChange={(event) => change({ name: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label id="mcp-transport-label">Transport</Label>
              <RadioGroup
                aria-labelledby="mcp-transport-label"
                value={draft.transport}
                onValueChange={(transport) => {
                  if (transport !== draft.transport)
                    change({ transport: transport === "http" ? "http" : "stdio", entries: [] });
                }}
              >
                <Label className="cursor-pointer">
                  <Radio value="stdio" /> Command (stdio)
                </Label>
                <Label className="cursor-pointer">
                  <Radio value="http" /> HTTP
                </Label>
              </RadioGroup>
            </div>
            {draft.transport === "stdio" ? (
              <>
                <div className="grid gap-1">
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    value={draft.command}
                    onChange={(event) => change({ command: event.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="mcp-args">Arguments, one per line</Label>
                  <Textarea
                    id="mcp-args"
                    value={draft.args}
                    onChange={(event) => change({ args: event.target.value })}
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-1">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  value={draft.url}
                  onChange={(event) => change({ url: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Don't put secrets in the URL; add them as headers.
                </p>
              </div>
            )}
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">
                {draft.transport === "stdio" ? "Environment variables" : "Headers"}
              </legend>
              {draft.entries.map((entry, index) => (
                <div key={entry.id} className="flex gap-2">
                  <Input
                    aria-label={`Key ${index + 1}`}
                    disabled={entry.value === "••••••"}
                    value={entry.key}
                    onChange={(event) =>
                      change({
                        entries: draft.entries.map((row, i) =>
                          i === index ? { ...row, key: event.target.value } : row,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={`Value ${index + 1}`}
                    type="password"
                    value={entry.value}
                    onChange={(event) =>
                      change({
                        entries: draft.entries.map((row, i) =>
                          i === index ? { ...row, value: event.target.value } : row,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => change({ entries: draft.entries.filter((_, i) => i !== index) })}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    change({
                      entries: [...draft.entries, { id: randomUUID(), key: "", value: "" }],
                    })
                  }
                >
                  Add key
                </Button>
              </div>
            </fieldset>
            {error || serverError ? (
              <p role="alert" className="text-sm text-destructive">
                {error || serverError}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="mcp-server-form" disabled={pending}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
