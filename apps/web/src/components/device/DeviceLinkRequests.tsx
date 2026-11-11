import { useAtomValue } from "@effect/atom-react";
import type { DeviceServiceState, EnvironmentId } from "@t3tools/contracts";
import { Link2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { deviceEnvironment } from "~/state/device";
import { useAtomCommand } from "~/state/use-atom-command";

/** A linked environment's agent waiting for this user to let it use a device set to "Ask first". */
export function DeviceLinkRequests(props: {
  readonly environmentId: EnvironmentId;
  readonly state: DeviceServiceState;
  readonly className?: string;
}) {
  const canAnswer = useAtomValue(
    deviceEnvironment.answerLinkRequest.permissionAtom(props.environmentId),
  );
  const answer = useAtomCommand(deviceEnvironment.answerLinkRequest);
  const requests = props.state.linkRequests ?? [];
  if (requests.length === 0) return null;
  return (
    <ul aria-label="Device requests from linked environments" className={cn(props.className)}>
      {requests.map((request) => (
        <li
          key={request.requestId}
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-foreground/12 px-3 py-2 text-xs"
        >
          <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 basis-48 text-foreground">
            {request.threadTitle
              ? `“${request.threadTitle}” on ${request.linkLabel} wants to use ${request.deviceName}.`
              : `${request.linkLabel} wants to use ${request.deviceName}.`}
          </span>
          <span className="ml-auto flex shrink-0 gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={!canAnswer}
              onClick={() =>
                void answer({
                  environmentId: props.environmentId,
                  input: { requestId: request.requestId, allow: false },
                })
              }
            >
              Don't allow
            </Button>
            <Button
              size="xs"
              disabled={!canAnswer}
              onClick={() =>
                void answer({
                  environmentId: props.environmentId,
                  input: { requestId: request.requestId, allow: true },
                })
              }
            >
              Allow
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
