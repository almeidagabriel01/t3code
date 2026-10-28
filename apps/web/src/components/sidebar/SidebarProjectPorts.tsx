import { AuthDiagnosticsReadScope, type ProjectId } from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LivePortsList } from "../statusBar/LivePortsList";
import { useListeningPorts } from "../statusBar/useListeningPorts";

function ProjectPortsContent({ projectIds }: { readonly projectIds: ReadonlySet<ProjectId> }) {
  const { environmentId, ports } = useListeningPorts({ fast: true });
  const projectPorts = ports.filter(
    (port) => port.projectId !== null && projectIds.has(port.projectId),
  );
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-foreground">{`Live ports (${projectPorts.length})`}</span>
      <LivePortsList environmentId={environmentId} ports={projectPorts} />
    </div>
  );
}

export function SidebarProjectPorts({
  projectIds,
}: {
  readonly projectIds: ReadonlySet<ProjectId>;
}) {
  const [open, setOpen] = useState(false);
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  if (!canRead) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="micro" aria-label="Project ports" />}
      >
        <PlugIcon aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="right" align="start" width="lg">
        {open ? <ProjectPortsContent projectIds={projectIds} /> : null}
      </PopoverPopup>
    </Popover>
  );
}
