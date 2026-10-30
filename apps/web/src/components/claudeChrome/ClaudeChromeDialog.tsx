import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { CLAUDE_CHROME_LINKS } from "@t3tools/shared/claudeChrome";
import { CheckIcon, DownloadIcon, RefreshCwIcon, ShieldCheckIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

/** Status and the default switch, shared by the dialog and the provider settings row. */
export function useClaudeChrome(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  const status = useEnvironmentQuery(
    serverEnvironment.claudeChromeStatus({ environmentId, input: { instanceId } }),
  );
  const setDefault = useAtomCommand(serverEnvironment.setClaudeChromeDefault, {
    reportFailure: false,
  });
  const canSet = useAtomValue(
    serverEnvironment.setClaudeChromeDefault.permissionAtom(environmentId),
  );
  const setEnabled = async (enabled: boolean) => {
    const result = await setDefault({ environmentId, input: { instanceId, enabled } });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Couldn't change Claude in Chrome",
      description: error instanceof Error ? error.message : "The request failed.",
    });
  };
  return { status, canSet, setEnabled };
}

function openLink(url: string) {
  void ensureLocalApi().shell.openExternal(url);
}

const LINKS = [
  { label: "Install extension", url: CLAUDE_CHROME_LINKS.install, icon: DownloadIcon },
  { label: "Reconnect extension", url: CLAUDE_CHROME_LINKS.reconnect, icon: UnplugIcon },
  { label: "Manage site permissions", url: CLAUDE_CHROME_LINKS.permissions, icon: ShieldCheckIcon },
] as const;

function ApplyToThread(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const restart = useAtomCommand(orchestrationEnvironment.restartProviderSession, {
    reportFailure: false,
  });
  const canRestart = useAtomValue(
    orchestrationEnvironment.restartProviderSession.permissionAtom(props.environmentId),
  );
  const [state, setState] = useState<
    | { readonly kind: "idle" | "busy" | "done" }
    | { readonly kind: "failed"; readonly message: string }
  >({ kind: "idle" });
  const apply = async () => {
    setState({ kind: "busy" });
    const result = await restart({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    if (result._tag !== "Failure") return setState({ kind: "done" });
    if (isAtomCommandInterrupted(result)) return setState({ kind: "idle" });
    const error = squashAtomCommandFailure(result);
    setState({
      kind: "failed",
      message: error instanceof Error ? error.message : "The session could not be restarted.",
    });
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!canRestart || state.kind === "busy"}
        onClick={() => void apply()}
      >
        {state.kind === "busy" ? <Spinner /> : <RefreshCwIcon />}
        Apply to this thread
      </Button>
      {state.kind === "failed" ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {state.message}
        </p>
      ) : null}
      {state.kind === "done" ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5" />
          The next message starts a session with the new setting.
        </p>
      ) : null}
    </div>
  );
}

export function ClaudeChromeDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId?: ThreadId | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { status, canSet, setEnabled } = useClaudeChrome(props.environmentId, props.instanceId);
  const data = status.data;
  const extension =
    data === null
      ? null
      : data.extensionInstalled === null
        ? "Unknown"
        : data.extensionInstalled
          ? "Installed"
          : "Not detected";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Claude in Chrome</DialogTitle>
          <DialogDescription>
            Lets Claude use your Chrome: open pages, click, fill forms, read the console and
            network.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {data === null ? (
            status.error !== null ? (
              <div className="flex flex-col items-start gap-2">
                <p role="alert" className="text-sm text-destructive-foreground">
                  {status.error}
                </p>
                <Button variant="outline" size="sm" onClick={status.refresh}>
                  <RefreshCwIcon />
                  Retry
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Loading status
              </div>
            )
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <label htmlFor="claude-chrome-default" className="text-sm font-medium">
                    Enabled by default
                  </label>
                  <p className="text-xs text-muted-foreground">
                    New Claude sessions for this account start with the browser tools.
                  </p>
                  {data.launchOverride !== null ? (
                    <p className="text-xs text-muted-foreground">
                      Launch arguments force it {data.launchOverride} for this account (
                      <code>{data.launchOverride === "on" ? "--chrome" : "--no-chrome"}</code>).
                    </p>
                  ) : null}
                  {data.sharedConfig ? (
                    <p className="text-xs text-muted-foreground">
                      Shared by every Claude account that has no Claude home of its own.
                    </p>
                  ) : null}
                </div>
                <Switch
                  id="claude-chrome-default"
                  checked={data.enabledByDefault}
                  disabled={!canSet}
                  onCheckedChange={(checked) => void setEnabled(checked)}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Extension</span>
                <p className="text-xs text-muted-foreground">
                  {extension}
                  {data.pairedBrowser !== null ? ` · Paired with ${data.pairedBrowser}` : ""}
                </p>
              </div>
              {props.threadId !== undefined ? (
                <ApplyToThread environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}
              <div className="flex flex-wrap gap-2">
                {LINKS.map(({ label, url, icon: Icon }) => (
                  <Button key={url} variant="outline" size="sm" onClick={() => openLink(url)}>
                    <Icon />
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
