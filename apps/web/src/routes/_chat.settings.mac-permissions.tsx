import { createFileRoute } from "@tanstack/react-router";

import { MacPermissionsSettingsPanel } from "../components/settings/MacPermissionsSettings";

export const Route = createFileRoute("/_chat/settings/mac-permissions")({
  component: MacPermissionsSettingsPanel,
});
