import type { ProjectId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { deriveProjectIdentity } from "../../projectIdentity";
import { projectIconColorClassName } from "../../projectIconColors";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";

export interface KanbanProjectInfo {
  readonly name: string;
  readonly projectKey: string;
  readonly project: ProjectFaviconProject & {
    readonly id: ProjectId;
    readonly isScratch?: true;
  };
}

/** "No project" groups every environment's Scratch project; the environment tells them apart. */
export function kanbanProjectName(
  group: {
    readonly displayName: string;
    readonly isScratch?: true;
    readonly memberProjects: ReadonlyArray<unknown>;
  },
  member: { readonly environmentLabel: string | null },
): string {
  return group.isScratch && group.memberProjects.length > 1 && member.environmentLabel
    ? `${group.displayName} · ${member.environmentLabel}`
    : group.displayName;
}

/** The color the sidebar badge resolves to for this project, as a text color class. */
export function projectAccentClassName(info: KanbanProjectInfo): string {
  const icon = info.project.projectIcon;
  return projectIconColorClassName(
    icon?.kind === "monogram" || icon?.kind === "lucide"
      ? icon.color
      : deriveProjectIdentity(info.project.title).color,
  );
}

export function KanbanProjectBadge(props: {
  readonly info: KanbanProjectInfo;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        props.className,
      )}
    >
      <ProjectFavicon project={props.info.project} className="size-4" />
      <span className="truncate">{props.info.name}</span>
    </span>
  );
}
