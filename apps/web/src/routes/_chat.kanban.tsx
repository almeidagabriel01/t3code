import { createFileRoute } from "@tanstack/react-router";

import { KanbanPage } from "../components/kanban/KanbanPage";

export interface KanbanSearch {
  projectKey?: string;
  card?: string;
  new?: true;
}

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 200) : undefined;

export const Route = createFileRoute("/_chat/kanban")({
  validateSearch: (raw: Record<string, unknown>): KanbanSearch => {
    const projectKey = text(raw.projectKey);
    const card = text(raw.card);
    return {
      ...(projectKey ? { projectKey } : {}),
      ...(card ? { card } : {}),
      ...(raw.new === true || raw.new === "true" ? { new: true as const } : {}),
    };
  },
  component: KanbanPage,
});
