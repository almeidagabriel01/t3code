import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** A centered empty, loading or error note inside a project view. */
export function ProjectViewMessage(props: { readonly title: string; readonly detail?: string }) {
  return (
    <View className="items-center gap-1 px-6 pt-8">
      <Text className="text-center font-t3-medium text-sm text-foreground">{props.title}</Text>
      {props.detail ? (
        <Text className="text-center text-xs text-foreground-muted">{props.detail}</Text>
      ) : null}
    </View>
  );
}
