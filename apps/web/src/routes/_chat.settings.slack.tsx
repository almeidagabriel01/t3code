import { createFileRoute } from "@tanstack/react-router";

import { SlackSettingsPanel } from "../components/settings/SlackSettings";

export const Route = createFileRoute("/_chat/settings/slack")({
  component: SlackSettingsPanel,
});
