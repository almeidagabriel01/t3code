import * as DateTime from "effect/DateTime";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import type { OrchestrationV2ProviderSession, ServerProvider } from "@t3tools/contracts";

export interface ProviderSessionRestartNotice {
  readonly providerName: string;
  readonly installedVersion: string;
  /** Why the restart cannot happen now; null when the button can act. */
  readonly blocked: "running" | "shared" | null;
}

/** Pulls the first x.y.z[-pre] out of strings like "2.1.3 (Claude Code)" or "v2.1.3-beta.1". */
const extractVersion = (raw: string): string | null => {
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(raw);
  return match !== null && parseSemver(match[0]) !== null ? match[0] : null;
};

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
    if (installed === null) continue;
    const installedVersion = extractVersion(installed);
    const sessionVersion = extractVersion(session.providerVersion);
    if (
      installedVersion === null ||
      sessionVersion === null ||
      compareSemverVersions(installedVersion, sessionVersion) <= 0
    ) {
      continue;
    }
    return {
      providerName: provider.displayName ?? provider.driver,
      installedVersion,
      blocked: input.running
        ? "running"
        : session.capabilities.sessions.supportsMultipleProviderThreadsPerSession
          ? "shared"
          : null,
    };
  }
  return null;
}
