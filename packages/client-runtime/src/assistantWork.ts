import {
  isProviderAvailable,
  type Assistant,
  type AssistantSandboxStatus,
  type MemoryItem,
  type ModelSelection,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/** Where a status card's button goes; each client maps it to its own navigation. */
export type AssistantWorkFix = "providers" | "startSandbox" | "resumeAutonomy" | "editAssistant";

export type AssistantWorkStatus =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `blocked` cannot work at all; `limited` still answers when messaged. */
      readonly severity: "blocked" | "limited";
      readonly title: string;
      readonly detail: string;
      readonly fix: { readonly kind: AssistantWorkFix; readonly label: string } | null;
    };

export interface AssistantWorkStatusInput {
  readonly assistant: Pick<Assistant, "workspace">;
  readonly projectFound: boolean;
  /** The conversation's model; null until its thread exists. */
  readonly modelSelection: ModelSelection | null;
  /** Null while the environment's providers are not known yet. */
  readonly providers: ReadonlyArray<ServerProvider> | null;
  /** Null before the sandbox's first report. */
  readonly sandbox: Pick<AssistantSandboxStatus, "state" | "error"> | null;
  /** The global autonomy switch; null when unknown. */
  readonly autonomyEnabled: boolean | null;
}

type WorkFix = { readonly kind: AssistantWorkFix; readonly label: string } | null;

const blocked = (title: string, detail: string, fix: WorkFix): AssistantWorkStatus => ({
  ok: false,
  severity: "blocked",
  title,
  detail,
  fix,
});

const SANDBOX_REASON = {
  not_created: "Its sandbox has not been created yet.",
  starting: "Its sandbox is starting.",
  stopped: "Its sandbox container is stopped.",
  docker_unavailable: "Docker is not running, so its sandbox cannot start.",
  failed: "Its sandbox failed to start.",
} as const;

/**
 * Whether the assistant can work right now, and when not, why and where to fix it. First match
 * wins, most fundamental first. Unknown inputs (no providers yet, no sandbox report) never block.
 */
export function assistantWorkStatus(input: AssistantWorkStatusInput): AssistantWorkStatus {
  const { assistant, modelSelection, providers, sandbox } = input;
  if (!input.projectFound) {
    return blocked("Its project is missing", "The project it works in is no longer available.", {
      kind: "editAssistant",
      label: "Choose a project",
    });
  }
  if (assistant.workspace === "sandbox" && sandbox !== null && sandbox.state !== "running") {
    const reason = SANDBOX_REASON[sandbox.state as keyof typeof SANDBOX_REASON];
    return blocked(
      "Its sandbox is not running",
      sandbox.state === "failed" && sandbox.error !== null ? sandbox.error : reason,
      sandbox.state === "docker_unavailable" || sandbox.state === "starting"
        ? null
        : { kind: "startSandbox", label: "Start sandbox" },
    );
  }
  if (modelSelection !== null && providers !== null) {
    const provider = providers.find((entry) => entry.instanceId === modelSelection.instanceId);
    const name = provider?.displayName ?? modelSelection.instanceId;
    if (
      provider === undefined ||
      !provider.enabled ||
      !provider.installed ||
      !isProviderAvailable(provider)
    ) {
      return blocked(`${name} is not available`, "Its provider is off, not installed or down.", {
        kind: "providers",
        label: "Open providers",
      });
    }
    if (provider.auth.status === "unauthenticated") {
      return blocked(`${name} is signed out`, "Sign in to its provider to let it work.", {
        kind: "providers",
        label: "Sign in",
      });
    }
    if (
      provider.models.length > 0 &&
      !provider.models.some((model) => model.slug === modelSelection.model)
    ) {
      return blocked(
        "Its model is not available",
        `${modelSelection.model} is not offered by ${name} any more.`,
        { kind: "editAssistant", label: "Choose a model" },
      );
    }
  }
  if (input.autonomyEnabled === false) {
    return {
      ok: false,
      severity: "limited",
      title: "Autonomy is paused",
      detail: "It does not wake on its own. It still answers when you message it.",
      fix: { kind: "resumeAutonomy", label: "Resume autonomy" },
    };
  }
  return { ok: true };
}

/** What Retry sends for the assistant's latest run, or null when that run needs no retry. */
export type AssistantRetryPlan =
  | { readonly kind: "continue"; readonly runId: RunId }
  | { readonly kind: "again" };

/**
 * A stopped run, or one that hit a usage limit, is continued where it stopped; the server accepts
 * a manual continuation only for those. Any other failure asks the same conversation to try again.
 */
export function assistantRetryPlan(
  shell: Pick<EnvironmentThreadShell, "latestRun" | "runtime"> | null,
): AssistantRetryPlan | null {
  const run = shell?.latestRun;
  if (run === null || run === undefined) return null;
  if (run.status === "interrupted") return { kind: "continue", runId: run.runId };
  if (run.status !== "failed") return null;
  return shell?.runtime?.lastErrorClass === "usage_limit"
    ? { kind: "continue", runId: run.runId }
    : { kind: "again" };
}

/** What Retry says to the assistant, so both clients send the same words. */
export const ASSISTANT_RETRY_TEXT = {
  continue: "Continue where you left off.",
  again: "That did not finish. Please try again.",
} as const;

/** The memory scopes that hold what the assistant learned: its conversation, and its project when it has one. */
export function assistantMemoryScopeKinds(
  assistant: Pick<Assistant, "scope">,
): ReadonlyArray<"thread" | "project"> {
  return assistant.scope === "project" ? ["thread", "project"] : ["thread"];
}

export interface AssistantMemory {
  readonly item: Extract<MemoryItem, { status: "active" }>;
  /** The conversation of this assistant the memory was learned in; null when it has no thread source. */
  readonly sourceThreadId: ThreadId | null;
}

/**
 * The active memories an assistant's conversations are the source of, newest first. Thread-scoped
 * memories of its current conversation (`ownThreadIds`) count even without thread evidence.
 */
export function assistantMemories(
  items: ReadonlyArray<MemoryItem>,
  assistantId: string,
  environmentId: string,
  ownThreadIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<AssistantMemory> {
  const prefix = `assistant:${assistantId}:`;
  const seen = new Set<string>();
  const found: Array<AssistantMemory> = [];
  for (const item of items) {
    if (item.status !== "active" || seen.has(item.memoryId)) continue;
    const source = item.payload.evidence.find(
      (evidence) =>
        evidence.sourceThread?.environmentId === environmentId &&
        evidence.sourceThread.threadId.startsWith(prefix),
    )?.sourceThread;
    const own = item.scope.kind === "thread" && ownThreadIds.has(item.scope.thread.threadId);
    if (source === undefined && !own) continue;
    seen.add(item.memoryId);
    found.push({
      item,
      sourceThreadId:
        source?.threadId ?? (item.scope.kind === "thread" ? item.scope.thread.threadId : null),
    });
  }
  return found.sort((a, b) =>
    b.item.revision.createdAtUtc.localeCompare(a.item.revision.createdAtUtc),
  );
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const LOCAL_DAY = new Intl.DateTimeFormat("en-US", {
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** The local calendar day of an instant, as a day count. */
function localDayNumber(ms: number): number {
  const part = (type: string) =>
    Number(LOCAL_DAY.formatToParts(ms).find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

/** "Today 9:00 AM", "Tomorrow 9:00 AM", "Wed 9:00 AM" within a week, else "Nov 20, 9:00 AM", in local time. */
export function formatNextRun(iso: string, nowMs: number): string {
  const atMs = Date.parse(iso);
  if (Number.isNaN(atMs)) return "";
  const days = localDayNumber(atMs) - localDayNumber(nowMs);
  const time = CLOCK.format(atMs);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY.format(atMs)} ${time}`;
  return `${MONTH_DAY.format(atMs)}, ${time}`;
}
