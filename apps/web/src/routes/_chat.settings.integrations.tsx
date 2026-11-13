import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/integrations/IntegrationsSettingsPage";

export const Route = createFileRoute("/_chat/settings/integrations")({
  // `entry`: a catalog id agents link to; it opens that integration.
  validateSearch: (raw: Record<string, unknown>) =>
    typeof raw.entry === "string" && raw.entry.trim() ? { entry: raw.entry.trim() } : {},
  component: IntegrationsRoute,
});

function IntegrationsRoute() {
  return <IntegrationsSettingsPanel entry={Route.useSearch().entry} />;
}
