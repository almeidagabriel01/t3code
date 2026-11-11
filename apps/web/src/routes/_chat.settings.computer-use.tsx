import { createFileRoute } from "@tanstack/react-router";

import { ComputerUseHostSettingsPanel } from "../components/settings/ComputerUseHostSettings";

export const Route = createFileRoute("/_chat/settings/computer-use")({
  component: ComputerUseHostSettingsPanel,
});
