import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useProjects } from "../../state/entities";

const NONE = "";

/** Picks one of the environment's projects, or none. */
export function NoteProjectPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly value: string | null;
  readonly noneLabel: string;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly onChange: (project: ProjectId | null) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const current = projects.find((project) => project.id === props.value);
  return (
    <Menu
      actions={[
        { id: NONE, title: props.noneLabel, state: props.value === null ? "on" : "off" },
        ...projects.map((project) => ({
          id: project.id,
          title: project.title,
          state: project.id === props.value ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) =>
        props.onChange(nativeEvent.event === NONE ? null : (nativeEvent.event as ProjectId))
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        disabled={props.disabled === true}
        className="min-h-9 flex-row items-center gap-2 self-start rounded-full bg-secondary px-4 active:opacity-70"
      >
        <Text textRole="footnote" numberOfLines={1} className="font-t3-medium text-foreground">
          {current?.title ?? (props.value === null ? props.noneLabel : "Unknown project")}
        </Text>
        <SymbolView name="chevron.down" size={12} tintColorClassName="accent-chevron" />
      </Pressable>
    </Menu>
  );
}
