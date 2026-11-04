import { createFileRoute } from "@tanstack/react-router";

import { TelegramSettingsPanel } from "../components/settings/TelegramSettings";

export const Route = createFileRoute("/_chat/settings/telegram")({
  component: TelegramSettingsPanel,
});
