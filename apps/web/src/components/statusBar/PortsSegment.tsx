import type { EnvironmentId, ListeningPort, ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, PlugIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PortRow } from "./LivePortsList";
import { useEnvironmentListeningPorts } from "./useListeningPorts";

const SECTION_HEADER =
  "sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/40 bg-popover px-3 py-2";

function EnvironmentPorts({
  environmentId,
  label,
  ports,
  projectTitleById,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly ports: ReadonlyArray<ListeningPort>;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const byProject = new Map<ProjectId, ListeningPort[]>();
  const other: ListeningPort[] = [];
  for (const port of ports) {
    if (port.projectId === null) other.push(port);
    else byProject.set(port.projectId, [...(byProject.get(port.projectId) ?? []), port]);
  }
  const groups = [...byProject].toSorted(([a], [b]) =>
    (projectTitleById.get(a) ?? "").localeCompare(projectTitleById.get(b) ?? ""),
  );

  return (
    <div>
      {label === null ? null : (
        <div className="border-b border-border/40 bg-muted/30 px-3 py-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
      )}
      {groups.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
          No project ports detected
        </div>
      ) : null}
      {groups.map(([projectId, group]) => (
        <section key={projectId} className="border-t border-border/40 first:border-t-0">
          <div className={SECTION_HEADER}>
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {projectTitleById.get(projectId) ?? "Project"}
            </span>
            <span className="font-mono text-3xs text-muted-foreground/70">{group.length}</span>
          </div>
          <div className="px-1 pb-1">
            {group.map((port) => (
              <PortRow
                key={`${port.pid ?? ""}:${port.host}:${port.port}`}
                environmentId={environmentId}
                port={port}
              />
            ))}
          </div>
        </section>
      ))}
      <div className="border-t border-border/60">
        <Collapsible open={otherOpen} onOpenChange={setOtherOpen}>
          <CollapsibleTrigger
            className={`${SECTION_HEADER} w-full text-left text-2xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent/50 hover:text-foreground`}
          >
            <span className="flex items-center gap-1.5">
              {otherOpen ? (
                <ChevronDownIcon aria-hidden className="size-3" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3" />
              )}
              Other ports
            </span>
            <span className="font-mono text-3xs">{other.length}</span>
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            <div className="px-1 pb-1">
              {other.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  No other ports detected
                </div>
              ) : (
                other.map((port) => (
                  <PortRow
                    key={`${port.pid ?? ""}:${port.host}:${port.port}`}
                    environmentId={environmentId}
                    port={port}
                  />
                ))
              )}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </div>
  );
}

export function PortsSegment() {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  const connected = environments.filter(({ connection }) => connection.phase === "connected");
  const portsByEnvironment = useEnvironmentListeningPorts(
    connected.map(({ environmentId }) => environmentId),
    open,
  );
  const readable = connected.filter(({ environmentId }) => portsByEnvironment.has(environmentId));
  if (readable.length === 0) return null;
  const all = readable.flatMap(({ environmentId }) => portsByEnvironment.get(environmentId) ?? []);
  const projectCount = all.filter((port) => port.projectId !== null).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="status-bar"
            size="status-bar"
            aria-label={`Ports, ${projectCount} project ${projectCount === 1 ? "port" : "ports"}`}
          />
        }
      >
        <PlugIcon aria-hidden />
        <span className="font-medium tabular-nums">{projectCount}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" padding="none" className="w-[24rem]">
        <PortsPanel
          environments={readable.map(({ environmentId, label }) => ({ environmentId, label }))}
          portsByEnvironment={portsByEnvironment}
          projectCount={projectCount}
          otherCount={all.length - projectCount}
        />
      </PopoverPopup>
    </Popover>
  );
}

function PortsPanel({
  environments,
  portsByEnvironment,
  projectCount,
  otherCount,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly portsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ListeningPort>>;
  readonly projectCount: number;
  readonly otherCount: number;
}) {
  const projects = useProjects();
  const projectTitleById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.title]),
  );
  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-2xs font-medium text-foreground">
          <PlugIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">Ports</span>
        </div>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {projectCount} project · {otherCount} other
        </span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        {environments.map(({ environmentId, label }) => (
          <EnvironmentPorts
            key={environmentId}
            environmentId={environmentId}
            label={environments.length > 1 ? label : null}
            ports={portsByEnvironment.get(environmentId) ?? []}
            projectTitleById={projectTitleById}
          />
        ))}
      </div>
    </div>
  );
}
