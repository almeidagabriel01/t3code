import type { AppSymbolName } from "../../components/ui/AppSymbol";

/** The project sheet's sections, in order; web shows the same five as right-panel tabs. */
export const PROJECT_VIEWS = ["board", "scheduled", "activity", "memory", "heavy-work"] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number];

export const PROJECT_VIEW_META: Record<
  ProjectView,
  { readonly title: string; readonly icon: AppSymbolName }
> = {
  board: { title: "Board", icon: "square.grid.2x2" },
  scheduled: { title: "Scheduled", icon: "calendar.badge.clock" },
  activity: { title: "Activity", icon: "bell.badge" },
  memory: { title: "Memory", icon: "brain" },
  "heavy-work": { title: "Heavy work", icon: "hourglass" },
};

/** The sections an environment offers: Board needs boards there. */
export function projectViewsFor(boards: boolean): ReadonlyArray<ProjectView> {
  return boards ? PROJECT_VIEWS : PROJECT_VIEWS.filter((view) => view !== "board");
}

/** The section to show: the one asked for when offered, else the first. */
export function resolveProjectView(
  views: ReadonlyArray<ProjectView>,
  wanted: string | undefined,
): ProjectView {
  return views.find((view) => view === wanted) ?? views[0]!;
}

const COMMANDS: Record<
  ProjectView,
  { readonly key: string; readonly title: string; readonly searchTerms: ReadonlyArray<string> }
> = {
  board: { key: "projectBoard", title: "Board for", searchTerms: ["kanban", "cards", "tasks"] },
  scheduled: {
    key: "projectScheduledTasks",
    title: "Scheduled tasks in",
    searchTerms: ["agenda", "automations", "routines", "calendar"],
  },
  activity: {
    key: "projectActivity",
    title: "Activity in",
    searchTerms: ["finished", "failed", "waiting", "runs", "inbox"],
  },
  memory: {
    key: "projectMemory",
    title: "Memory for",
    searchTerms: ["memories", "remember", "forget", "rules"],
  },
  "heavy-work": {
    key: "projectHeavyWork",
    title: "Heavy work in",
    searchTerms: ["queue", "tests", "builds", "commands", "stop", "priority"],
  },
};

/** One command palette entry per section, each opening the sheet on that section. */
export function projectViewCommands(views: ReadonlyArray<ProjectView>, projectTitle: string) {
  return views.map((view) => ({
    view,
    key: COMMANDS[view].key,
    title: `${COMMANDS[view].title} ${projectTitle}`,
    searchTerms: [...COMMANDS[view].searchTerms, "project"],
  }));
}
