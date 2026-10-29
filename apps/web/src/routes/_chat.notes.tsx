import { NotePath, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { NotesPage } from "../components/notes/NotesPage";

const isNotePath = Schema.is(NotePath);

export interface NotesSearch {
  environmentId?: EnvironmentId;
  projectKey?: string;
  path?: string;
  create?: true;
}

export const Route = createFileRoute("/_chat/notes")({
  validateSearch: (raw: Record<string, unknown>): NotesSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.length > 0
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectKey === "string" && raw.projectKey.length > 0
      ? { projectKey: raw.projectKey.slice(0, 200) }
      : {}),
    ...(isNotePath(raw.path) ? { path: raw.path } : {}),
    ...(raw.create === true || raw.create === "true" ? { create: true as const } : {}),
  }),
  component: NotesRoute,
});

function NotesRoute() {
  return <NotesPage {...Route.useSearch()} />;
}
