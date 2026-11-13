import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/integrations/IntegrationsSettingsPage";

export const Route = createFileRoute("/_chat/settings/integrations")({
  component: IntegrationsSettingsPanel,
});
