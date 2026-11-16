import type { SidebarProjectGroupingMode, SidebarThreadOrder } from "@t3tools/contracts";

export const GROUPING_OPTIONS: ReadonlyArray<{
  readonly mode: SidebarProjectGroupingMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "repository",
    label: "Group by repository",
    description: "Matching repositories appear as one project.",
  },
  {
    mode: "repository_path",
    label: "Group by repository path",
    description: "Keep monorepo paths separate.",
  },
  {
    mode: "separate",
    label: "Keep separate",
    description: "Show every workspace as its own project.",
  },
];

export const THREAD_ORDER_OPTIONS: ReadonlyArray<{
  readonly order: SidebarThreadOrder;
  readonly label: string;
  readonly description: string;
}> = [
  {
    order: "activity",
    label: "Recent activity",
    description:
      "What needs you or finished unseen comes first, then running agents, then the rest.",
  },
  {
    order: "fixed",
    label: "Fixed",
    description: "Threads stay where they are; move them to reorder.",
  },
];

/** The General page's fixed labels; Settings search reads these same strings. */
export const GENERAL_COPY = {
  projectGrouping: { title: "Project grouping" },
  threadOrder: { title: "Thread order" },
  newThreads: {
    title: "New threads",
    lastProject: "Use last project",
    lastProjectDescription:
      "New threads still ask for the project, with the last one you used on this device first.",
  },
} as const;

const optionText = (options: ReadonlyArray<{ label: string; description: string }>) =>
  options.flatMap(({ label, description }) => [label, description]);

export const GENERAL_PAGE_LABELS: readonly string[] = [
  GENERAL_COPY.projectGrouping.title,
  ...optionText(GROUPING_OPTIONS),
  GENERAL_COPY.threadOrder.title,
  ...optionText(THREAD_ORDER_OPTIONS),
  ...Object.values(GENERAL_COPY.newThreads),
];
