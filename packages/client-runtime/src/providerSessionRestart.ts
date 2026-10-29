import * as DateTime from "effect/DateTime";
import type { OrchestrationV2ProviderSession, ServerProvider } from "@t3tools/contracts";

export interface ProviderSessionRestartNotice {
  readonly providerName: string;
  readonly installedVersion: string;
  /** Why the restart cannot happen now; null when the button can act. */
  readonly blocked: "running" | "shared" | null;
}

const stripV = (version: string) => version.replace(/^v/, "");

/** A live session whose CLI is older than the one now installed, so a restart picks up the new one. */
export function deriveProviderSessionRestartNotice(input: {
  readonly sessions: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderSession,
      "providerInstanceId" | "providerVersion" | "status" | "capabilities" | "updatedAt"
    >
  >;
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "version" | "installedVersion">
  >;
  readonly running: boolean;
}): ProviderSessionRestartNotice | null {
  for (const session of [...input.sessions].sort(
    (left, right) =>
      DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
  )) {
    if (session.status === "stopped" || session.status === "error") continue;
    if (session.providerVersion === undefined) continue;
    const provider = input.providers.find(
      (candidate) => candidate.instanceId === session.providerInstanceId,
    );
    if (provider === undefined) continue;
    const installed =
      provider.installedVersion !== undefined ? provider.installedVersion : provider.version;
    if (installed === null || stripV(installed) === stripV(session.providerVersion)) continue;
    return {
      providerName: provider.displayName ?? provider.driver,
      installedVersion: stripV(installed),
      blocked: input.running
        ? "running"
        : session.capabilities.sessions.supportsMultipleProviderThreadsPerSession
          ? "shared"
          : null,
    };
  }
  return null;
}
