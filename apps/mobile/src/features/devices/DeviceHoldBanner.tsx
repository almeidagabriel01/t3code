import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../components/ui/GlassSurface";

export function DeviceHoldBanner(props: {
  readonly disabled?: boolean;
  readonly onHandBack: () => void;
}) {
  return (
    <View className="px-3 py-2">
      <GlassSurface className="flex-row items-center gap-3 py-2 pl-4 pr-2">
        <View className="flex-1">
          <AppText className="font-t3-medium text-sm">You are in control</AppText>
          <AppText className="text-xs text-foreground-muted">The agent is paused.</AppText>
        </View>
        <Button
          label="Hand back"
          icon="arrow.uturn.backward"
          tone="primary"
          size="compact"
          disabled={props.disabled === true}
          onPress={props.onHandBack}
        />
      </GlassSurface>
    </View>
  );
}
