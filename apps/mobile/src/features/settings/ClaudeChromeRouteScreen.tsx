import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { CLAUDE_CHROME_LINKS } from "@t3tools/shared/claudeChrome";
import { useState } from "react";
import { Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { BLOCKED_REASON } from "../threads/ProviderSessionRestartNotice";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export type ClaudeChromeParams = {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId?: ThreadId;
};

const LINKS = [
  { key: "install", icon: "arrow.down.circle", label: "Install extension" },
  { key: "reconnect", icon: "arrow.clockwise", label: "Reconnect extension" },
  { key: "permissions", icon: { ios: "lock", android: "lock" }, label: "Manage site permissions" },
] as const;

export function ClaudeChromeRouteScreen({ route }: StaticScreenProps<ClaudeChromeParams>) {
  const { environmentId, instanceId, threadId } = route.params;
  const insets = useSafeAreaInsets();
  const status = useEnvironmentQuery(
    serverEnvironment.claudeChromeStatus({ environmentId, input: { instanceId } }),
  );
  const setDefault = useAtomCommand(serverEnvironment.setClaudeChromeDefault);
  const canSet = useAtomValue(
    serverEnvironment.setClaudeChromeDefault.permissionAtom(environmentId),
  );
  const restart = useAtomCommand(orchestrationEnvironment.restartProviderSession);
  const canRestart = useAtomValue(
    orchestrationEnvironment.restartProviderSession.permissionAtom(environmentId),
  );
  const structure = useQuietThreadStructure(threadId ? { environmentId, threadId } : null);
  const shared =
    structure?.projection.providerSessions.some(
      (session) =>
        session.providerInstanceId === instanceId &&
        session.status !== "stopped" &&
        session.status !== "error" &&
        session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
    ) ?? false;
  const [restartState, setRestartState] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const data = status.data;
  const blocked = shared ? BLOCKED_REASON.shared : null;
  return (
    <SettingsScreen title="Claude in Chrome">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          Lets Claude use your Chrome: open pages, click, fill forms, read the console and network.
        </Text>
        {data === null ? (
          status.error !== null ? (
            <View className="gap-3 px-2">
              <Text accessibilityRole="alert" className="text-danger-foreground">
                {`Could not load the Chrome status: ${status.error}`}
              </Text>
              <ListActionRow icon="arrow.clockwise" label="Try again" onPress={status.refresh} />
            </View>
          ) : (
            <View className="items-center p-4">
              <AppActivityIndicator colorClassName="accent-icon" />
            </View>
          )
        ) : (
          <>
            <SettingsSection>
              <ListToggleRow
                icon="safari"
                label="Enabled by default"
                description="New Claude sessions for this account start with the browser tools."
                value={data.enabledByDefault}
                disabled={!canSet}
                onValueChange={(enabled) =>
                  void setDefault({ environmentId, input: { instanceId, enabled } })
                }
              />
              {data.launchOverride !== null ? (
                <Text textRole="footnote" className="px-4 pb-3 text-foreground-muted">
                  {`Launch arguments force it ${data.launchOverride} for this account (${
                    data.launchOverride === "on" ? "--chrome" : "--no-chrome"
                  }).`}
                </Text>
              ) : null}
              {data.sharedConfig ? (
                <Text textRole="footnote" className="px-4 pb-3 text-foreground-muted">
                  Shared by every Claude account that has no Claude home of its own.
                </Text>
              ) : null}
            </SettingsSection>
            <SettingsSection>
              <View className="gap-1 px-4 py-3">
                <Text textRole="body" className="text-foreground">
                  Extension
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {data.extensionInstalled === null
                    ? "Unknown"
                    : data.extensionInstalled
                      ? "Installed"
                      : "Not detected"}
                  {data.pairedBrowser ? ` · Paired with ${data.pairedBrowser}` : ""}
                </Text>
              </View>
            </SettingsSection>
          </>
        )}
        {threadId ? (
          <SettingsSection
            footer={
              blocked ??
              (restartState === "done"
                ? "The next message starts a session with the new setting."
                : restartState === "failed"
                  ? "Could not restart the session."
                  : undefined)
            }
          >
            <ListActionRow
              icon="bolt.circle"
              label="Apply to this thread"
              loading={restartState === "pending"}
              disabled={blocked !== null || !canRestart}
              onPress={() => {
                setRestartState("pending");
                void restart({ environmentId, input: { threadId } }).then((result) =>
                  setRestartState(result._tag === "Success" ? "done" : "failed"),
                );
              }}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection>
          {LINKS.map((link) => (
            <ListActionRow
              key={link.key}
              icon={link.icon}
              label={link.label}
              onPress={() => void Linking.openURL(CLAUDE_CHROME_LINKS[link.key])}
            />
          ))}
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
