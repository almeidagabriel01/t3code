import type { ReactElement, ReactNode } from "react";
import { attributeTerminalUsage, type ResourceUsage } from "../statusBar/resourceUsage.logic";
import type { ProjectId } from "@t3tools/contracts";
import { CopyIcon, PlugIcon, SquareIcon, SquareTerminalIcon } from "lucide-react";

import { useThreadShells } from "../../state/entities";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { formatMemory } from "../statusBar/statusBar.logic";
import {
  useEnvironmentResources,
  useEnvironmentSnapshots,
} from "../statusBar/useEnvironmentResources";
import { useListeningPorts } from "../statusBar/useListeningPorts";
import { useCloseTerminal, useKillListeningPort } from "../statusBar/useKillTarget";

const SECTION_TITLE_CLASS =
  "flex items-center gap-1.5 px-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground";

function Section(props: { icon: ReactNode; title: string; count: number; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className={SECTION_TITLE_CLASS}>
        {props.icon}
        <span>
          {props.title}{" "}
          <span className="font-normal tabular-nums text-muted-foreground/70">({props.count})</span>
        </span>
      </div>
      <div className="space-y-0.5 border-l border-border/70 pl-3">{props.children}</div>
    </section>
  );
}

function LivePorts(props: { memberIds: ReadonlySet<ProjectId> }) {
  const { environmentId, canRead, ports } = useListeningPorts({ fast: true });
  const { canKill, kill } = useKillListeningPort(environmentId);
  if (!canRead) return null;
  const projectPorts = ports.filter(
    (port) => port.projectId !== null && props.memberIds.has(port.projectId),
  );
  if (projectPorts.length === 0) return null;
  return (
    <Section
      icon={<PlugIcon aria-hidden className="size-3" />}
      title="Live ports"
      count={projectPorts.length}
    >
      {projectPorts.map((port) => {
        const address = `${port.host}:${port.port}`;
        return (
          <div
            key={`${port.pid ?? ""}:${port.host}:${port.port}`}
            className="group/port grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent/50"
          >
            <span className="select-text font-mono text-xs font-semibold tabular-nums text-foreground">
              {port.port}
            </span>
            <span className="flex min-w-0 select-text items-baseline gap-1 text-2xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {port.processName ?? (port.pid === null ? "Unknown process" : `PID ${port.pid}`)}
              </span>
              <span className="shrink-0 text-muted-foreground/45">-</span>
              <span className="min-w-0 flex-[1.1] truncate text-muted-foreground/70">
                {port.host}
              </span>
            </span>
            <span className="flex items-center opacity-0 transition-opacity group-focus-within/port:opacity-100 group-hover/port:opacity-100">
              <Button
                variant="ghost-muted"
                size="icon-micro"
                aria-label={`Copy ${address}`}
                onClick={() => void navigator.clipboard.writeText(address)}
              >
                <CopyIcon aria-hidden />
              </Button>
              {canKill && port.pid !== null ? (
                <Button
                  variant="ghost-destructive"
                  size="icon-micro"
                  aria-label={`Kill process on port ${port.port}`}
                  onClick={() => void kill(port)}
                >
                  <SquareIcon aria-hidden />
                </Button>
              ) : null}
            </span>
          </div>
        );
      })}
    </Section>
  );
}

function TerminalRow(props: {
  environmentId: Parameters<typeof useCloseTerminal>[0];
  label: string;
  cwd: string;
  busy: boolean;
  usage: ResourceUsage | null;
  threadId: Parameters<ReturnType<typeof useCloseTerminal>["close"]>[0]["threadId"];
  terminalId: string;
}) {
  const { canClose, close } = useCloseTerminal(props.environmentId);
  return (
    <div className="group/terminal flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-2xs hover:bg-accent/50">
      <span className="min-w-0 flex-1 truncate text-foreground">
        {props.label}
        <span className="text-muted-foreground"> · {props.cwd}</span>
      </span>
      <span className="shrink-0 text-muted-foreground">{props.busy ? "busy" : "idle"}</span>
      {props.usage === null ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatMemory(props.usage.rssBytes)} · {Math.round(props.usage.cpuPercent)}%
        </span>
      )}
      {canClose ? (
        <Button
          variant="ghost-destructive"
          size="icon-micro"
          aria-label={`Close terminal ${props.label}`}
          onClick={() =>
            void close({ threadId: props.threadId, terminalId: props.terminalId }, props.label)
          }
        >
          <SquareIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

function RunningTerminals(props: { memberKeys: ReadonlySet<string> }) {
  const resources = useEnvironmentResources(true);
  const threads = useThreadShells();
  const projectByThread = new Map(
    threads.map((thread) => [
      `${thread.environmentId}:${thread.id}`,
      `${thread.environmentId}:${thread.projectId}`,
    ]),
  );
  const rows = resources.flatMap(({ environmentId, terminals }) =>
    terminals
      .filter(
        (session) =>
          session.state.status === "running" &&
          props.memberKeys.has(
            projectByThread.get(`${environmentId}:${session.target.threadId}`) ?? "",
          ),
      )
      .map((session) => ({
        environmentId,
        session,
        key: `${session.target.threadId}:${session.target.terminalId}`,
      })),
  );
  const snapshots = useEnvironmentSnapshots([...new Set(rows.map((row) => row.environmentId))]);
  if (rows.length === 0) return null;
  return (
    <Section
      icon={<SquareTerminalIcon aria-hidden className="size-3" />}
      title="Running"
      count={rows.length}
    >
      {rows.map(({ environmentId, session, key }) => {
        const summary = session.state.summary;
        const usage = attributeTerminalUsage(snapshots.get(environmentId)?.processes ?? [], [
          { key, projectKey: null, pid: summary?.pid ?? null },
        ]).terminals.get(key);
        return (
          <TerminalRow
            key={key}
            environmentId={environmentId}
            label={summary?.label || session.target.terminalId}
            cwd={summary?.cwd.split("/").findLast(Boolean) ?? ""}
            busy={session.state.hasRunningSubprocess}
            usage={snapshots.has(environmentId) ? (usage ?? null) : null}
            threadId={session.target.threadId}
            terminalId={session.target.terminalId}
          />
        );
      })}
    </Section>
  );
}

function ProjectHoverContent(props: { project: SidebarProjectSnapshot }) {
  const { project } = props;
  const memberIds = new Set(project.memberProjects.map((member) => member.id));
  const memberKeys = new Set(
    project.memberProjects.map((member) => `${member.environmentId}:${member.id}`),
  );
  return (
    <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-3">
      <div className="min-w-0">
        <div className="break-words text-sm font-semibold leading-snug text-foreground">
          {project.displayName}
        </div>
        <div className="mt-1 break-words font-mono text-2xs leading-snug text-muted-foreground">
          {project.workspaceRoot}
        </div>
      </div>
      <RunningTerminals memberKeys={memberKeys} />
      <LivePorts memberIds={memberIds} />
    </div>
  );
}

export function SidebarProjectHoverCard(props: {
  project: SidebarProjectSnapshot;
  children: ReactElement;
}) {
  return (
    <PreviewCard>
      <PreviewCardTrigger delay={400} closeDelay={150} render={props.children} />
      <PreviewCardPopup side="right" align="start" className="w-96 max-w-[90vw]">
        <ProjectHoverContent project={props.project} />
      </PreviewCardPopup>
    </PreviewCard>
  );
}
