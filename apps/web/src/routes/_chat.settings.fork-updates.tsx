import { createFileRoute } from "@tanstack/react-router";

import { ForkUpdatesSettingsPanel } from "../components/settings/ForkUpdatesSettings";

export const Route = createFileRoute("/_chat/settings/fork-updates")({
  component: ForkUpdatesSettingsPanel,
});
