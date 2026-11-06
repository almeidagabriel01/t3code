import { Platform, Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";

export function SendToMainChatButton(props: {
  readonly iconColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Send to main chat"
      onPress={props.onPress}
      className="h-7 w-7 items-center justify-center"
      style={
        Platform.OS === "android"
          ? { width: props.buttonSize, height: props.buttonSize }
          : undefined
      }
    >
      <SymbolView
        name="arrow.turn.left.up"
        size={props.iconSize}
        tintColor={props.iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}
