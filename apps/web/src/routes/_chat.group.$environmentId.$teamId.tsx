import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AssistantGroupChat } from "../components/assistants/AssistantGroupChat";

export interface GroupChatSearch {
  /** A request to scroll to and highlight, by its first message's id. */
  request?: string;
  /** The tab it sits in: "all", "general" or "project:<id>". */
  tab?: string;
}

function GroupChatRoute() {
  const { environmentId, teamId } = Route.useParams();
  const { request, tab } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <AssistantGroupChat
      key={`${environmentId}:${teamId}`}
      environmentId={environmentId as EnvironmentId}
      teamId={teamId as AssistantTeamId}
      focusRequest={request}
      focusTab={tab}
      onFocused={() => void navigate({ to: ".", search: {}, replace: true })}
    />
  );
}

const shortString = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

export const Route = createFileRoute("/_chat/group/$environmentId/$teamId")({
  validateSearch: (raw: Record<string, unknown>): GroupChatSearch => {
    const request = shortString(raw.request);
    const tab = shortString(raw.tab);
    return {
      ...(request === undefined ? {} : { request }),
      ...(tab === undefined ? {} : { tab }),
    };
  },
  component: GroupChatRoute,
});
