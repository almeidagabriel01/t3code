import { createFileRoute } from "@tanstack/react-router";

import { AssistantsSettingsPanel } from "../components/settings/AssistantsSettings";

export const Route = createFileRoute("/_chat/settings/assistants")({
  component: AssistantsSettingsPanel,
});
