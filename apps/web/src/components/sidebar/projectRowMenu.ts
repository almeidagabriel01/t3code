import type { ContextMenuItem } from "@t3tools/contracts";

type ProjectRowMenuAction = "project-settings" | "archive-project";

export function projectRowMenuItems(input: {
  readonly archived: boolean;
  readonly canArchive: boolean;
}): ContextMenuItem<ProjectRowMenuAction>[] {
  return [
    { id: "project-settings", label: "Project settings" },
    ...(input.canArchive
      ? [
          {
            id: "archive-project" as const,
            label: input.archived ? "Unarchive project" : "Archive project",
          },
        ]
      : []),
  ];
}

export async function showProjectRowMenu(input: {
  readonly show: (
    items: ContextMenuItem<ProjectRowMenuAction>[],
    position: { x: number; y: number },
  ) => Promise<ProjectRowMenuAction | null>;
  readonly archived: boolean;
  readonly canArchive: boolean;
  readonly position: { x: number; y: number };
  readonly onSettings: () => void;
  readonly onToggleArchive: () => void;
}): Promise<void> {
  const clicked = await input.show(projectRowMenuItems(input), input.position);
  if (clicked === "project-settings") input.onSettings();
  else if (clicked === "archive-project") input.onToggleArchive();
}
