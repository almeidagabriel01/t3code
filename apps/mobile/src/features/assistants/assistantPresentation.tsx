import type { Assistant, AssistantToolAccess } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { AppSymbolName } from "../../components/ui/AppSymbol";

export const TOOL_ACCESS_OPTIONS: ReadonlyArray<{
  readonly value: AssistantToolAccess;
  readonly label: string;
  readonly description: string;
  readonly icon: AppSymbolName;
}> = [
  {
    value: "read-only",
    label: "Read only",
    description: "Reads files and answers. It cannot change files or run commands that write.",
    icon: "eye",
  },
  {
    value: "workspace-write",
    label: "Edit files",
    description: "Edits files without asking. Commands and other actions still ask first.",
    icon: "pencil",
  },
  {
    value: "full",
    label: "Full access",
    description: "Runs commands and edits files without asking.",
    icon: "bolt.circle",
  },
];

export function toolAccessLabel(access: AssistantToolAccess): string {
  return TOOL_ACCESS_OPTIONS.find((option) => option.value === access)?.label ?? access;
}

function hueOf(handle: string): number {
  let hash = 0;
  for (const char of handle) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/** The assistant's initial on a tint taken from its handle, so each reads as itself. */
export function AssistantAvatar(props: {
  readonly assistant: Pick<Assistant, "name" | "handle">;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  const hue = hueOf(props.assistant.handle);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: `hsla(${hue}, 70%, 55%, 0.22)`,
      }}
    >
      <Text
        className="font-t3-bold"
        style={{ fontSize: size * 0.46, color: `hsl(${hue}, 60%, 45%)` }}
      >
        {props.assistant.name.trim().slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}
