import { ASSISTANT_ICONS } from "@t3tools/client-runtime/assistantIcons";
import { assistantInitial } from "@t3tools/client-runtime/assistantPresence";
import type { AssistantIconId } from "@t3tools/contracts";
import { View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { AssistantIconGlyph } from "./assistantPresentation";

const optionClass = (selected: boolean) =>
  cn(
    "size-11 items-center justify-center rounded-full border-2",
    selected ? "border-primary" : "border-border",
  );

/** One choice: an original icon, or the initial for none. */
export function AssistantIconPicker(props: {
  readonly value: AssistantIconId | null;
  readonly name: string;
  readonly onChange: (icon: AssistantIconId | null) => void;
}) {
  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          Icon
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          Shown instead of its initial.
        </Text>
      </View>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2 px-2">
        <RowPressable
          accessibilityRole="radio"
          accessibilityLabel="Initial"
          accessibilityState={{ selected: props.value === null }}
          onPress={() => props.onChange(null)}
          className={optionClass(props.value === null)}
        >
          <Text className="font-t3-bold text-foreground">{assistantInitial(props.name)}</Text>
        </RowPressable>
        {ASSISTANT_ICONS.map((icon) => (
          <RowPressable
            key={icon.id}
            accessibilityRole="radio"
            accessibilityLabel={icon.label}
            accessibilityState={{ selected: props.value === icon.id }}
            onPress={() => props.onChange(icon.id)}
            className={optionClass(props.value === icon.id)}
          >
            <AssistantIconGlyph icon={icon.id} size={24} colorClassName="accent-icon" />
          </RowPressable>
        ))}
      </View>
    </View>
  );
}
