import { useAtomValue } from "@effect/atom-react";
import type { ChannelLanguage, EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/** The server's language for T3's own messages in chats, and the write that changes it. */
export function useChannelLanguage(environmentId: EnvironmentId) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "channel language update",
    reportFailure: true,
  });
  return {
    language: settings?.channelLanguage ?? "auto",
    set: (channelLanguage: ChannelLanguage) =>
      update({ environmentId, input: { patch: { channelLanguage } } }),
  };
}
