import { createFileRoute } from "@tanstack/react-router";

import { KanbanSettingsPanel } from "../components/settings/KanbanSettings";

export const Route = createFileRoute("/_chat/settings/kanban")({
  component: KanbanSettingsPanel,
});
