import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../components/ui/GlassSurface";

/** Who drives the device now. Without `onHandBack`, it is not this user's to hand back. */
export function DeviceHoldBanner(props: {
  readonly disabled?: boolean;
  readonly heldBy?: string | null;
  readonly onHandBack?: (() => void) | undefined;
}) {
  return (
    <View className="px-3 py-2">
      <GlassSurface className="flex-row items-center gap-3 py-2 pl-4 pr-2">
        <View className="flex-1">
          <AppText className="font-t3-medium text-sm">
            {props.heldBy ? `${props.heldBy} is in control` : "You are in control"}
          </AppText>
          <AppText className="text-xs text-foreground-muted">
            {props.heldBy ? "Agents are paused." : "The agent is paused."}
          </AppText>
        </View>
        {props.onHandBack ? (
          <Button
            label="Hand back"
            icon="arrow.uturn.backward"
            tone="primary"
            size="compact"
            disabled={props.disabled === true}
            onPress={props.onHandBack}
          />
        ) : null}
      </GlassSurface>
    </View>
  );
}
