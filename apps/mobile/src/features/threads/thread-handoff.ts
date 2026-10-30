import type {
  ModelSelection,
  OrchestrationV2ThreadHandoffInput,
  OrchestrationV2ThreadHandoffMode,
  ThreadId,
} from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";

export const HANDOFF_LABEL = "Hand off to another agent";
export const HANDOFF_ICON = "arrow.left.arrow.right";

export const HANDOFF_CONTEXT_CHOICES = [
  {
    mode: "focused",
    label: "Focused (Recommended)",
    description:
      "Starts from the latest request and reply, and reads older details only when needed.",
  },
  {
    mode: "full",
    label: "Full transcript",
    description:
      "Includes the saved transcript, the most recent part if it is very long. Takes longer and uses more context or credits.",
  },
] as const satisfies ReadonlyArray<{
  readonly mode: OrchestrationV2ThreadHandoffMode;
  readonly label: string;
  readonly description: string;
}>;

export const DEFAULT_HANDOFF_MODE: OrchestrationV2ThreadHandoffMode = "focused";

/** Nothing to hand off before the first message. Draft threads never offer it. */
export function canHandoffThread(thread: { readonly latestUserMessageAt: unknown }): boolean {
  return thread.latestUserMessageAt !== null;
}

export function findHandoffOption(
  options: ReadonlyArray<ModelOption>,
  wanted: ModelSelection | null | undefined,
): ModelOption | undefined {
  if (!wanted) return undefined;
  return options.find(
    (option) =>
      option.selection.instanceId === wanted.instanceId && option.selection.model === wanted.model,
  );
}

/** Display names for the sheet; the raw model slug only when the catalog no longer lists it. */
export function resolveHandoffAgents(input: {
  readonly options: ReadonlyArray<ModelOption>;
  readonly selection: ModelSelection | null;
  readonly source: ModelSelection | null | undefined;
}) {
  const agentOption = findHandoffOption(input.options, input.selection);
  const sourceOption = findHandoffOption(input.options, input.source);
  return {
    agentOption,
    agentLabel: agentOption?.label ?? input.selection?.model ?? "Choose an agent",
    sourceLabel: sourceOption?.label ?? input.source?.model ?? "Unknown",
  };
}

export function canStartHandoff(input: {
  readonly permitted: boolean;
  readonly selection: ModelSelection | null;
  readonly starting: boolean;
}): boolean {
  return input.permitted && input.selection !== null && !input.starting;
}

export function buildHandoffInput(input: {
  readonly sourceThreadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly mode: OrchestrationV2ThreadHandoffMode;
  readonly clientRequestId: string;
  readonly instructions?: string;
}): OrchestrationV2ThreadHandoffInput {
  const { instructions, ...rest } = input;
  const trimmed = instructions?.trim();
  return { ...rest, ...(trimmed ? { instructions: trimmed } : {}), creationSource: "mobile" };
}
