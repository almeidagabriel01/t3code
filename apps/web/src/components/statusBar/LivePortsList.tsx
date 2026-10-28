import type { EnvironmentId, ListeningPort, ProjectId } from "@t3tools/contracts";
import { SquareIcon } from "lucide-react";

import { Button } from "../ui/button";
import { useKillListeningPort } from "./useKillTarget";

export function LivePortsList({
  environmentId,
  ports,
  projectTitleById,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly ports: ReadonlyArray<ListeningPort>;
  readonly projectTitleById?: ReadonlyMap<ProjectId, string>;
}) {
  const { canKill, kill } = useKillListeningPort(environmentId);
  if (ports.length === 0) {
    return <span className="text-xs text-muted-foreground">No listening ports.</span>;
  }
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {ports.map((port) => {
        const project = port.projectId === null ? undefined : projectTitleById?.get(port.projectId);
        return (
          <li
            key={`${port.pid ?? ""}:${port.host}:${port.port}`}
            className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto_1.25rem] items-center gap-x-2"
          >
            <span className="font-medium tabular-nums text-foreground">{port.port}</span>
            <span className="truncate text-muted-foreground">
              {port.processName ?? "unknown"}
              {port.pid === null ? "" : ` (${port.pid})`} · {port.host}
            </span>
            <span className="max-w-32 truncate text-muted-foreground">{project ?? ""}</span>
            {canKill && port.pid !== null ? (
              <Button
                variant="ghost-destructive"
                size="icon-micro"
                aria-label={`Kill process on port ${port.port}`}
                onClick={() => void kill(port)}
              >
                <SquareIcon aria-hidden />
              </Button>
            ) : (
              <span />
            )}
          </li>
        );
      })}
    </ul>
  );
}
