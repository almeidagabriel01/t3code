import { createFileRoute } from "@tanstack/react-router";

import { AssistantsPage } from "../components/assistants/AssistantsPage";

export const Route = createFileRoute("/_chat/assistants")({
  component: AssistantsPage,
});
