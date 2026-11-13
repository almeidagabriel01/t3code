import {
  formatDuration,
  HEAVY_COMMAND_SOURCE_LABEL,
  heavyCommandKey,
  heavyRowUsage,
  projectForCommand,
  runningUsageLine,
} from "@t3tools/client-runtime/state/heavyQueueModel";
import type { EnvironmentId, HeavyCommand } from "@t3tools/contracts";
import {
  BotIcon,
  CircleStopIcon,
  EllipsisIcon,
  FolderIcon,
  MessageSquareIcon,
  TerminalIcon,
  UnplugIcon,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  FOCUS_RING,
  GLYPH,
  GUTTER,
  Metrics,
  ROW_HOVER,
  ROW_LINE,
  UNDER_NAME,
} from "./ResourceMetrics";
import { useStopHeavyCommand } from "./useKillTarget";

const ELAPSED_REFRESH_MS = 5_000;

export function Elapsed({ since, prefix }: { readonly since: string; readonly prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coarse timer so the elapsed time does not repaint continuously
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const duration = formatDuration(since, now);
  return <>{prefix === undefined ? duration : `${prefix} ${duration}`}</>;
}

export interface HeavyCommandThreads {
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly projectIdOfThread: (threadId: string) => string | undefined;
  readonly onOpenThread: (threadId: string) => void;
}

/** One labelled fact of a row; `mono` for command lines and paths. */
export interface Fact {
  readonly label: string;
  readonly value: ReactNode;
  readonly mono?: boolean;
}

function Facts({ facts }: { readonly facts: ReadonlyArray<Fact> }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs leading-snug">
      {facts.map(({ label, value, mono }) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={cn("min-w-0 break-words text-foreground", mono && "font-mono break-all")}>
            {value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** A thread fact: a link in the expanded row, plain text in the tooltip. */
export function threadFact(
  threadId: string | null,
  threads: Pick<HeavyCommandThreads, "threadTitle" | "onOpenThread">,
  interactive: boolean,
): ReadonlyArray<Fact> {
  if (threadId === null) return [];
  const title = threads.threadTitle(threadId) ?? "Open thread";
  return [
    {
      label: "Thread",
      value: interactive ? (
        <button
          type="button"
          onClick={() => threads.onOpenThread(threadId)}
          className={cn(
            "cursor-pointer rounded-sm text-start underline-offset-2 hover:underline",
            FOCUS_RING,
          )}
        >
          {title}
        </button>
      ) : (
        title
      ),
    },
  ];
}

/** The project a heavy row belongs to: its avatar and name, or its folder when no project holds it. */
export function ProjectChip({
  project,
  folder,
}: {
  readonly project: (ProjectFaviconProject & { readonly title: string }) | undefined;
  readonly folder?: string | undefined;
}) {
  const text = project?.title ?? folder?.split(/[\\/]/).findLast(Boolean);
  if (text === undefined) return null;
  return (
    <span className="flex max-w-28 min-w-0 items-center gap-1 rounded-full bg-foreground/6 py-px pr-1.5 pl-1 text-3xs text-muted-foreground">
      {project === undefined ? (
        <FolderIcon aria-hidden className="size-3 shrink-0" />
      ) : (
        <ProjectFavicon project={project} className="size-3 shrink-0" />
      )}
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * A heavy row: glyph, name, project, short state, usage in the shared columns and a menu. The
 * name stretches over the line as the disclosure: hover or focus shows every fact in a tooltip,
 * a click keeps them open below.
 */
export function HeavyRow({
  name,
  glyph,
  chip,
  state,
  usage,
  menu,
  secondLine,
  facts,
  children,
  rowRef,
  style,
  className,
}: {
  readonly name: string;
  readonly glyph: ReactNode;
  readonly chip?: ReactNode;
  readonly state: ReactNode;
  readonly usage: ComponentProps<typeof Metrics>["usage"];
  readonly menu?: ReactNode;
  /** Shown only when the eye needs it, such as why a job waits. */
  readonly secondLine?: string | undefined;
  readonly facts: (interactive: boolean) => ReadonlyArray<Fact>;
  /** Prompts that need an answer stay visible under the row. */
  readonly children?: ReactNode;
  readonly rowRef?: Ref<HTMLDivElement>;
  readonly style?: CSSProperties;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div ref={rowRef} style={style} className={className}>
      <div className={cn(ROW_LINE, ROW_HOVER, "group/row")}>
        <span className={cn(GLYPH, "relative z-10")}>{glyph}</span>
        <Tooltip disabled={open}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="min-w-22 flex-1 cursor-pointer truncate text-start text-xs font-medium text-foreground/90 outline-none after:absolute after:inset-0 focus-visible:after:ring-1 focus-visible:after:ring-ring focus-visible:after:ring-inset"
              />
            }
          >
            {name}
          </TooltipTrigger>
          <TooltipPopup side="left" align="start" className="w-80 max-w-sm">
            <Facts facts={facts(false)} />
          </TooltipPopup>
        </Tooltip>
        {chip}
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{state}</span>
        <Metrics usage={usage} />
        <span className={cn(GUTTER, "relative z-10")}>{menu}</span>
      </div>
      {secondLine === undefined || secondLine === "" ? null : (
        <div
          className={cn(UNDER_NAME, "-mt-1 truncate pr-3 pb-1.5 text-2xs text-muted-foreground")}
        >
          {secondLine}
        </div>
      )}
      {children}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsiblePanel>
          <div className={cn(UNDER_NAME, "pt-0.5 pr-3 pb-2.5")}>
            <Facts facts={facts(true)} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

const SOURCE_ICON: Record<Exclude<HeavyCommand["source"], "queue">, typeof BotIcon> = {
  agent: BotIcon,
  terminal: TerminalIcon,
  detached: UnplugIcon,
};

/** A heavy command no queue entry covers: an agent's or terminal's own, or one outside T3. */
export function HeavyCommandRow({
  command,
  cpuCount,
  threads,
  stop,
  scopeProjectId,
}: {
  readonly command: HeavyCommand;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
  readonly stop: ReturnType<typeof useStopHeavyCommand>;
  readonly scopeProjectId?: string | undefined;
}) {
  const projects = useProjects();
  const project = projectForCommand(command, projects, threads.projectIdOfThread);
  const Icon = command.source === "queue" ? BotIcon : SOURCE_ICON[command.source];
  const { threadId } = command;
  const usage = heavyRowUsage(command, cpuCount);
  const canStop = command.stoppable && stop.canStop;
  const facts = (interactive: boolean): ReadonlyArray<Fact> => [
    { label: "Command", value: command.label, mono: true },
    ...(command.cwd === undefined ? [] : [{ label: "Folder", value: command.cwd, mono: true }]),
    ...threadFact(threadId, threads, interactive),
    { label: "Started by", value: HEAVY_COMMAND_SOURCE_LABEL[command.source] },
    { label: "Running", value: <Elapsed since={command.startedAt} /> },
    {
      label: "Usage",
      value: runningUsageLine(command, cpuCount) ?? "No sample yet",
    },
    ...(command.reason === undefined ? [] : [{ label: "Why", value: command.reason }]),
    { label: "Process", value: `pid ${command.pid}` },
  ];
  return (
    <HeavyRow
      name={command.name}
      glyph={<Icon aria-label={HEAVY_COMMAND_SOURCE_LABEL[command.source]} />}
      chip={
        project !== undefined && project.id === scopeProjectId ? null : (
          <ProjectChip project={project} folder={command.cwd} />
        )
      }
      state={<Elapsed since={command.startedAt} />}
      usage={usage}
      facts={facts}
      menu={
        threadId === null && !canStop ? null : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label={`Actions for ${command.name}`}
                />
              }
            >
              <EllipsisIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup side="top" align="end">
              {threadId === null ? null : (
                <MenuItem onClick={() => threads.onOpenThread(threadId)}>
                  <MessageSquareIcon aria-hidden />
                  Open thread
                </MenuItem>
              )}
              {threadId === null || !canStop ? null : <MenuSeparator />}
              {canStop ? (
                <MenuItem variant="destructive" onClick={() => void stop.stop(command)}>
                  <CircleStopIcon aria-hidden />
                  Stop
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        )
      }
    />
  );
}

/** Rows for heavy commands no queue entry covers, in the order given. */
export function HeavyCommandRows({
  environmentId,
  commands,
  cpuCount,
  threads,
  scopeProjectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly commands: ReadonlyArray<HeavyCommand>;
  readonly cpuCount: number;
  readonly threads: HeavyCommandThreads;
  readonly scopeProjectId?: string | undefined;
}) {
  const stop = useStopHeavyCommand(environmentId);
  return (
    <>
      {commands.map((command) => (
        <HeavyCommandRow
          key={heavyCommandKey(command)}
          command={command}
          cpuCount={cpuCount}
          threads={threads}
          stop={stop}
          scopeProjectId={scopeProjectId}
        />
      ))}
    </>
  );
}
