import { createFileRoute } from "@tanstack/react-router";
import { StatusBarSettingsPanel } from "../components/settings/StatusBarSettings";

export const Route = createFileRoute("/_chat/settings/status-bar")({
  component: StatusBarSettingsPanel,
});
