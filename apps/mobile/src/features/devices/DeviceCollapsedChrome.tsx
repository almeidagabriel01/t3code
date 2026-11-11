import { View } from "react-native";

import { ControlPill } from "../../components/ui/ControlPill";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { DeviceHoldBanner } from "./DeviceHoldBanner";

/** The full-screen viewer's chrome while its controls are hidden. A held device stays labelled. */
export function DeviceCollapsedChrome(props: {
  readonly top: number;
  readonly offsetX: number;
  readonly held: boolean;
  readonly canHold: boolean;
  readonly onClose: () => void;
  readonly onShowControls: () => void;
  readonly onHandBack: () => void;
}) {
  return (
    <View pointerEvents="box-none" className="absolute inset-x-0" style={{ top: props.top }}>
      <View
        pointerEvents="box-none"
        className="self-center"
        style={{ transform: [{ translateX: props.offsetX }] }}
      >
        <GlassSurface className="flex-row items-center gap-1 p-1">
          <SheetCloseButton accessibilityLabel="Close device preview" onClose={props.onClose} />
          <ControlPill
            accessibilityLabel="Show device controls"
            icon="chevron.down"
            onPress={props.onShowControls}
          />
        </GlassSurface>
      </View>
      {props.held ? (
        <DeviceHoldBanner disabled={!props.canHold} onHandBack={props.onHandBack} />
      ) : null}
    </View>
  );
}
