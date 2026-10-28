import { cn } from "../../lib/utils";
import { deriveProjectIdentity } from "../../projectIdentity";
import { projectIconColorClassName } from "../../projectIconColors";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";

export interface KanbanProjectInfo {
  readonly name: string;
  readonly projectKey: string;
  readonly project: ProjectFaviconProject;
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
