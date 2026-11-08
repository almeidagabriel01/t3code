import type { DesktopMicrophoneAccess } from "@t3tools/contracts";

export interface MicrophoneAccessDeps {
  readonly platform: NodeJS.Platform;
  /** `systemPreferences.getMediaAccessStatus("microphone")`. */
  readonly readStatus: () => string;
  /** `systemPreferences.askForMediaAccess("microphone")`. */
  readonly ask: () => Promise<boolean>;
}

let pendingAsk: Promise<DesktopMicrophoneAccess> | null = null;

/** Asks macOS once for the microphone; concurrent callers share the one prompt. */
export function resolveMicrophoneAccess(
  deps: MicrophoneAccessDeps,
): Promise<DesktopMicrophoneAccess> {
  if (deps.platform !== "darwin") return Promise.resolve("unsupported");
  let status: string;
  try {
    status = deps.readStatus();
  } catch {
    return Promise.resolve("unavailable");
  }
  if (status === "granted" || status === "denied" || status === "restricted")
    return Promise.resolve(status);
  if (status !== "not-determined") return Promise.resolve("unavailable");
  pendingAsk ??= deps
    .ask()
    .then(
      (granted): DesktopMicrophoneAccess => (granted ? "granted" : "denied"),
      (): DesktopMicrophoneAccess => "unavailable",
    )
    .finally(() => {
      pendingAsk = null;
    });
  return pendingAsk;
}
