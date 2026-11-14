import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { isAssistantHomeProject } from "@t3tools/client-runtime/state/projects";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function ProjectMultiPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly selected: ReadonlyArray<ProjectId>;
  readonly onChange: (next: ReadonlyArray<ProjectId>) => void;
  /** Muted text at the end of a row, such as who already reaches it. */
  readonly details?: ReadonlyMap<ProjectId, string>;
}) {
  const { selected, onChange } = props;
  const [query, setQuery] = useState("");
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && !isAssistantHomeProject(project),
  );
  const needle = fold(query.trim());
  const shown = projects.filter((project) => fold(project.title).includes(needle));

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        type="search"
        aria-label="Search projects"
        placeholder="Search projects"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown.length === 0 ? (
        <p className="px-1.5 py-1 text-xs text-muted-foreground">No projects match</p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {shown.map((project) => {
            const detail = props.details?.get(project.id);
            return (
              <li key={project.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/8 has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring/70">
                  <Checkbox
                    aria-label={project.title}
                    checked={selected.includes(project.id)}
                    onCheckedChange={(checked) =>
                      onChange(
                        checked
                          ? [...selected, project.id]
                          : selected.filter((id) => id !== project.id),
                      )
                    }
                  />
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  {project.archivedAt == null ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">Archived</span>
                  )}
                  {detail === undefined ? null : (
                    <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                      {detail}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
