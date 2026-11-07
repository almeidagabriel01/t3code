import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AssistantGroupChat } from "../components/assistants/AssistantGroupChat";

function GroupChatRoute() {
  const { environmentId, teamId } = Route.useParams();
  return (
    <AssistantGroupChat
      key={`${environmentId}:${teamId}`}
      environmentId={environmentId as EnvironmentId}
      teamId={teamId as AssistantTeamId}
    />
  );
}

export const Route = createFileRoute("/_chat/group/$environmentId/$teamId")({
  component: GroupChatRoute,
});
