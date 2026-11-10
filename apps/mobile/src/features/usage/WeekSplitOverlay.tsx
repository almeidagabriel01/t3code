import type { WeekBarSplit } from "@t3tools/shared/usagePace";
import { View } from "react-native";

/** Draws each scoped model's share of the week at the used (right) end of a bar that fills with what is left. */
export function WeekSplitOverlay(props: {
  readonly split: WeekBarSplit;
  readonly className: string;
  readonly color?: string | null | undefined;
}) {
  const total = props.split.models.reduce((sum, model) => sum + model.percent, 0);
  if (total <= 0) return null;
  return (
    <View
      pointerEvents="none"
      className="absolute inset-y-0 right-0 flex-row overflow-hidden rounded-full"
      style={{ width: `${total}%` }}
    >
      {props.split.models.map((model) => (
        <View
          key={model.name}
          testID="week-split-model"
          className={`opacity-50 ${props.className}`}
          style={[{ flex: model.percent }, props.color ? { backgroundColor: props.color } : null]}
        />
      ))}
    </View>
  );
}
