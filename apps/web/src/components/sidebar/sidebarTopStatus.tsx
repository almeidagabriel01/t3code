import { GUEST_WAITING_LABEL } from "@t3tools/client-runtime/sidebarZones";
import type { SidebarThreadStatus } from "@t3tools/client-runtime/state/thread-attention";
import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";

const TOP_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const;

type TopStatusIconName = keyof typeof TOP_STATUS_ICONS;

export interface SidebarTopStatus {
  readonly label: string;
  readonly icon: TopStatusIconName;
  readonly className: string;
}

export function TopStatusIcon(props: { icon: TopStatusIconName; className: string }) {
  if (props.icon === "working") {
    return <Spinner aria-hidden role="presentation" size="md" className="shrink-0" />;
  }
  const Icon = TOP_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}

/** The one status a sidebar row leads with. Approval and input already say the thread needs the user; a decision says it too, over the rest. */
export function resolveSidebarTopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly hasOpenDecision: boolean;
  readonly isWoke: boolean;
  readonly isUnread: boolean;
  readonly runtimeStatus?: string | null | undefined;
  readonly goalActive?: boolean | undefined;
}): SidebarTopStatus | null {
  const { status } = input;
  if (input.hasOpenDecision && status !== "approval" && status !== "input") {
    return { label: "Decision", icon: "input", className: "text-warning-foreground" };
  }
  switch (status) {
    case "working":
      return {
        label:
          input.runtimeStatus === "preparing"
            ? "Setting up"
            : input.goalActive === true
              ? "Goal"
              : "Working",
        icon: "working",
        className: "text-info-foreground",
      };
    case "waiting":
      return { label: "Waiting", icon: "waiting", className: "text-muted-foreground" };
    case "approval":
      return { label: "Approval", icon: "approval", className: "text-warning-foreground" };
    case "input":
      return { label: "Input", icon: "input", className: "text-warning-foreground" };
    case "request":
      return { label: GUEST_WAITING_LABEL, icon: "request", className: "text-guest-foreground" };
    case "limited":
      return { label: "Limited", icon: "failed", className: "text-warning-foreground" };
    case "failed":
      return { label: "Failed", icon: "failed", className: "text-error-foreground" };
    case "ready":
      break;
  }
  if (input.isWoke) return { label: "Woke", icon: "woke", className: "text-warning-foreground" };
  if (input.isUnread) return { label: "Done", icon: "done", className: "text-success-foreground" };
  return null;
}
