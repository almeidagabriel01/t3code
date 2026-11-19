import { useAtomValue } from "@effect/atom-react";
import { unseenHeavyNotices } from "@t3tools/client-runtime/state/heavyQueue";
import type { EnvironmentId, HeavyNotice, HeavyNoticeBatch } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { FullWindowOverlay } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Toast } from "../../components/ui/Toast";
import { useEnvironments } from "../../state/environments";
import { heavyQueueEnvironment } from "../../state/heavyQueue";

const EMPTY: HeavyNoticeBatch = [];
/** Shared by every environment: two servers on one Mac send the same notice under one id. */
const shown = new Map<string, string>();
const SHOWN_MS = { error: 15_000, warning: 15_000, info: 8_000 } as const;

interface Current {
  readonly notice: HeavyNotice;
  readonly environmentId: EnvironmentId;
}

/** Where a notice's action goes: its thread, or the heavy work queue in Settings. */
export const heavyNoticeHref = ({ notice, environmentId }: Current) =>
  notice.threadId === null
    ? "/settings/maintenance"
    : `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(notice.threadId)}`;

/** Heavy job notices from every environment, newest on top; lives outside the navigator. */
export function HeavyNoticeHost(props: { readonly navigate: (href: string) => void }) {
  const { environments } = useEnvironments();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState<Current | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer hides the toast after its tone's reading time
  useEffect(() => {
    if (current === null) return;
    const timer = setTimeout(() => setCurrent(null), SHOWN_MS[current.notice.tone]);
    return () => clearTimeout(timer);
  }, [current]);

  const toast =
    current === null ? null : (
      <View
        key={`${current.notice.id}:${current.notice.title}`}
        className="absolute inset-x-3 z-[100]"
        style={{ top: insets.top + 8 }}
        pointerEvents="box-none"
      >
        <Toast
          message={current.notice.title}
          description={current.notice.description}
          tone={current.notice.tone === "error" ? "danger" : current.notice.tone}
          action={{
            label: current.notice.threadId === null ? "Heavy work" : "Open thread",
            onPress: () => {
              setCurrent(null);
              props.navigate(heavyNoticeHref(current));
            },
          }}
          dismissMode="swipe"
          onDismiss={() => setCurrent(null)}
        />
      </View>
    );
  return (
    <>
      {environments.map(({ environmentId }) => (
        <EnvironmentNotices
          key={environmentId}
          environmentId={environmentId}
          onNotice={(notice) => setCurrent({ notice, environmentId })}
        />
      ))}
      {toast === null ? null : Platform.OS === "ios" ? (
        // Native sheets present above the app's root view; only this window layer sits over them.
        <FullWindowOverlay>
          <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {toast}
          </GestureHandlerRootView>
        </FullWindowOverlay>
      ) : (
        toast
      )}
    </>
  );
}

function EnvironmentNotices(props: {
  readonly environmentId: EnvironmentId;
  readonly onNotice: (notice: HeavyNotice) => void;
}) {
  const batch = AsyncResult.getOrElse(
    useAtomValue(heavyQueueEnvironment.notices({ environmentId: props.environmentId, input: {} })),
    () => EMPTY,
  );
  const { onNotice } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands each server notice to the host once; a remount replays the last batch
  useEffect(() => {
    const fresh = unseenHeavyNotices(batch, shown);
    const last = fresh.at(-1);
    if (last !== undefined) onNotice(last);
  }, [batch, onNotice]);
  return null;
}
