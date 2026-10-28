import type { EnvironmentId, ListeningPort } from "@t3tools/contracts";
import { CopyIcon, ExternalLinkIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { portAddress } from "./statusBar.logic";
import { useKillListeningPort } from "./useKillTarget";

function PortAction({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function PortRow({
  environmentId,
  port,
  detail,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly port: ListeningPort;
  /** Replaces the address line, e.g. with the owning project. */
  readonly detail?: string | undefined;
}) {
  const { canKill, kill } = useKillListeningPort(environmentId);
  const isLocal = usePrimaryEnvironmentId() === environmentId;
  const address = portAddress(port.host, port.port);
  const processLabel =
    port.processName ?? (port.pid === null ? "Unknown process" : `PID ${port.pid}`);

  return (
    <div className="group/port grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <span className="select-text font-mono text-xs font-semibold tabular-nums text-foreground">
        {port.port}
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="relative flex h-5 min-w-0 items-center">
          <span className="block min-w-0 select-text truncate text-2xs text-muted-foreground">
            {processLabel}
          </span>
          <div className="absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-md border border-border/40 bg-popover/95 px-0.5 opacity-0 shadow-xs transition-opacity group-focus-within/port:opacity-100 group-hover/port:opacity-100 pointer-coarse:opacity-100">
            {isLocal ? (
              <PortAction
                label="Open in browser"
                onClick={() => void ensureLocalApi().shell.openExternal(`http://${address}`)}
              >
                <ExternalLinkIcon aria-hidden />
              </PortAction>
            ) : null}
            <PortAction
              label={`Copy ${address}`}
              onClick={() =>
                void writeTextToClipboard(address, "address").then(() =>
                  toastManager.add({ type: "success", title: `Copied ${address}` }),
                )
              }
            >
              <CopyIcon aria-hidden />
            </PortAction>
            <PortAction
              label="Stop process"
              disabled={!canKill || port.pid === null}
              onClick={() => void kill(port)}
            >
              <Trash2Icon aria-hidden />
            </PortAction>
          </div>
        </div>
        <div className="select-text truncate text-3xs text-muted-foreground/70">
          {detail ?? address}
        </div>
      </div>
    </div>
  );
}
