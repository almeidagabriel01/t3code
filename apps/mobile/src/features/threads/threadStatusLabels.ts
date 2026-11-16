import { ASSISTANT_GROUP_STATUS_LABEL } from "@t3tools/client-runtime/assistantGroupChat";
import type { AssistantAttention } from "@t3tools/client-runtime/assistantList";
import { GUEST_WAITING_LABEL } from "@t3tools/client-runtime/sidebarZones";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import type { ThreadListV2Status } from "./threadListV2";

interface StatusLabel {
  // Null when the icon and timer carry the status on their own.
  readonly label: string | null;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
}
export const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: {
    label: "Approval",
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  request: {
    label: GUEST_WAITING_LABEL,
    icon: "person.crop.circle",
    className: "text-adaptive-fuchsia-600-300",
    iconTintClassName: "accent-adaptive-fuchsia-600-300",
  },
  working: {
    label: null,
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  waiting: {
    label: null,
    icon: "circle.dashed.inset.filled",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
  failed: {
    label: "Failed",
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: "Limited",
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
};
export const DONE_STATUS_LABEL: StatusLabel = {
  label: "Done",
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

const WORKING_STATUS_LABEL: StatusLabel = { ...STATUS_LABEL_BY_STATUS.working!, label: "Working" };
const DECISION_STATUS_LABEL: StatusLabel = {
  label: "Decision",
  icon: "questionmark.bubble",
  className: "text-warning-foreground",
  iconTintClassName: "accent-warning-foreground",
};
const PAUSED_STATUS_LABEL: StatusLabel = {
  label: ASSISTANT_GROUP_STATUS_LABEL.paused,
  icon: "pause",
  className: "text-warning-foreground",
  iconTintClassName: "accent-warning-foreground",
};

/** An assistant's or a group's status in a thread row's words; working keeps its word here. */
export function assistantStatusLabel(attention: AssistantAttention): StatusLabel {
  switch (attention) {
    case "decision":
      return DECISION_STATUS_LABEL;
    case "paused":
      return PAUSED_STATUS_LABEL;
    case "working":
      return WORKING_STATUS_LABEL;
    case "done":
      return DONE_STATUS_LABEL;
    default:
      return STATUS_LABEL_BY_STATUS[attention]!;
  }
}
