/**
 * Labels for projects listed side by side: a title shared by two or more gets the shortest
 * trailing folder segments of its root that set it apart ("server · apps"). Unique titles stay.
 */
export function projectPickerLabels(
  projects: ReadonlyArray<{ readonly title: string; readonly workspaceRoot: string }>,
): ReadonlyArray<string> {
  const segments = (project: { title: string; workspaceRoot: string }) => {
    const parts = project.workspaceRoot.split(/[\\/]+/).filter((part) => part !== "");
    // The leaf usually repeats the title, so it cannot tell two of them apart.
    return parts.at(-1)?.toLowerCase() === project.title.toLowerCase() && parts.length > 1
      ? parts.slice(0, -1)
      : parts;
  };
  const suffix = (parts: ReadonlyArray<string>, depth: number) => parts.slice(-depth).join("/");
  const byTitle = new Map<string, Array<ReadonlyArray<string>>>();
  for (const project of projects) {
    byTitle.set(project.title, [...(byTitle.get(project.title) ?? []), segments(project)]);
  }
  return projects.map((project) => {
    const group = byTitle.get(project.title) ?? [];
    if (group.length < 2) return project.title;
    const own = segments(project);
    for (let depth = 1; depth <= own.length; depth += 1) {
      const mine = suffix(own, depth);
      if (group.filter((other) => suffix(other, depth) === mine).length === 1) {
        return `${project.title} · ${mine}`;
      }
    }
    return `${project.title} · ${suffix(own, own.length)}`.replace(/ · $/, "");
  });
}
