import { createFileRoute } from "@tanstack/react-router";

import { ImessageSettingsPanel } from "../components/settings/ImessageSettings";

export const Route = createFileRoute("/_chat/settings/imessage")({
  component: ImessageSettingsPanel,
});
