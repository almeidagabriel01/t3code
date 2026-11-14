import { inheritedProjects } from "@t3tools/client-runtime/assistantProjectAccess";
import type { Assistant, AssistantTeam, EnvironmentId } from "@t3tools/contracts";

import { useProjects } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";

export function InheritedProjectsList(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
  readonly teams: ReadonlyArray<AssistantTeam>;
}) {
  const projects = useProjects();
  const rows = inheritedProjects(props.assistant, props.teams).flatMap((inherited) => {
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === props.environmentId && candidate.id === inherited.projectId,
    );
    return project === undefined ? [] : [{ ...inherited, project }];
  });
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">From groups</p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.projectId} className="flex items-center gap-2 px-1.5 py-1 text-sm">
            <ProjectFavicon project={row.project} className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{row.project.title}</span>
            <span className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">
              via {row.teamNames.join(", ")}
              {row.alsoOwn ? " · also its own" : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
