import { useAtomValue } from "@effect/atom-react";
import {
  deriveProviderSessionRestartNotice,
  type ProviderSessionRestartNotice,
} from "@t3tools/client-runtime/providerSessionRestart";
import type {
  EnvironmentId,
  OrchestrationV2ProviderSession,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const BLOCKED_REASON = {
  running: "Wait for the current turn to finish.",
  shared: "This session is shared by several threads and can't be restarted from one.",
} as const satisfies Record<NonNullable<ProviderSessionRestartNotice["blocked"]>, string>;

/** The provider CLI was updated on disk while this thread's session still runs the old one. */
export function useProviderSessionRestartBanner(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId;
  readonly sessions: ReadonlyArray<OrchestrationV2ProviderSession> | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly running: boolean;
}): ComposerBannerStackItem | null {
  const restart = useAtomCommand(orchestrationEnvironment.restartProviderSession);
  const canRestart = useAtomValue(
    orchestrationEnvironment.restartProviderSession.permissionAtom(input.environmentId ?? null),
  );
  const notice =
    input.environmentId === undefined || input.sessions === undefined
      ? null
      : deriveProviderSessionRestartNotice({
          sessions: input.sessions,
          providers: input.providers,
          running: input.running,
        });
  if (notice === null || input.environmentId === undefined) return null;
  const environmentId = input.environmentId;
  const blockedReason = notice.blocked === null ? null : BLOCKED_REASON[notice.blocked];
  const button = (
    <Button
      size="xs"
      variant="ghost"
      disabled={blockedReason !== null || !canRestart}
      onClick={() => void restart({ environmentId, input: { threadId: input.threadId } })}
    >
      Restart session
    </Button>
  );
  return {
    id: `provider-session-restart:${input.threadId}`,
    variant: "info",
    icon: <RefreshCwIcon />,
    title: `${notice.providerName} ${notice.installedVersion} installed`,
    description: "This thread is still on the older version. Restart it to switch.",
    actions:
      blockedReason === null ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
          <TooltipPopup side="top">{blockedReason}</TooltipPopup>
        </Tooltip>
      ),
  };
}
