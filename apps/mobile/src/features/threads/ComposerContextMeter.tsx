import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type ContextWindowSnapshot,
  contextWindowReading,
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useQuietThreadStructure } from "../../state/use-thread-detail";

const RING_SIZE = 16;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The words every context meter uses: its compact label, its summary and its token detail. */
function contextMeterText(usage: ContextWindowSnapshot) {
  const reading = contextWindowReading(usage);
  return {
    reading,
    label:
      reading.usedPercent === null ? formatTokens(usage.usedTokens) : `${reading.usedPercent}%`,
    summary:
      reading.usedPercent === null
        ? `Context: ${formatTokens(usage.usedTokens)} tokens used`
        : `Context: ${reading.usedPercent}% used`,
    detail:
      reading.maxTokens === null
        ? null
        : `${usage.usedTokens.toLocaleString("en-US")} of ${reading.maxTokens.toLocaleString("en-US")} tokens`,
  };
}

/** A ring and "NN%" for the composer; a tap shows how many tokens of the window are used. */
export function ComposerContextMeter(props: {
  readonly usage: ContextWindowSnapshot;
  /** Whose context it is, when not the thread's own ("Context of Ada in this request"). */
  readonly title?: string;
}) {
  const theme = useUniwindTheme();
  const { reading, label, summary, detail } = contextMeterText(props.usage);
  const title = props.title ?? "Context window";
  const tint =
    reading.tone === "error"
      ? theme["--color-danger"]
      : reading.tone === "warning"
        ? theme["--color-warning"]
        : theme["--color-foreground-muted"];
  return (
    <View className="shrink-0">
      <Menu
        title={title}
        actions={[
          {
            id: "context",
            title: summary,
            ...(detail === null ? {} : { subtitle: detail }),
            attributes: { disabled: true },
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}: ${summary}${detail === null ? "" : `, ${detail}`}`}
          hitSlop={6}
          className="h-8 cursor-pointer flex-row items-center gap-1 rounded-full px-1.5 active:opacity-70"
        >
          <Svg width={RING_SIZE} height={RING_SIZE}>
            <Circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              stroke={theme["--color-border"]}
              strokeWidth={RING_STROKE}
              fill="none"
            />
            {reading.usedPercent === null ? null : (
              <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                stroke={tint}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                fill="none"
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={RING_LENGTH * (1 - reading.usedPercent / 100)}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
              />
            )}
          </Svg>
          <Text className="font-t3-medium text-xs tabular-nums text-foreground-muted">{label}</Text>
        </Pressable>
      </Menu>
    </View>
  );
}

/** The meter for a thread's active session; nothing until the thread has reported usage. */
export function ThreadContextMeter(props: { readonly threadRef: ScopedThreadRef | null }) {
  // The quiet structure holds still while text streams, so the meter re-renders on usage only.
  const structure = useQuietThreadStructure(props.threadRef);
  if (structure === null) return null;
  const { projection } = structure;
  const providerThread =
    projection.providerThreads.find(
      (thread) => thread.id === projection.thread.activeProviderThreadId,
    ) ?? null;
  const usage = deriveLatestContextWindowSnapshot(
    projection.visibleTurnItems,
    latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread),
    providerThread,
  );
  return usage === null ? null : <ComposerContextMeter usage={usage} />;
}
