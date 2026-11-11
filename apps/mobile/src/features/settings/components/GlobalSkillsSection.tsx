import { useAtomValue } from "@effect/atom-react";
import { t3SkillsOf } from "@t3tools/client-runtime/state/global-skills";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProviderSkill } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { RowPressable } from "../../../components/ui/RowPressable";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { globalSkillsEnvironment } from "../../../state/globalSkills";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";

/** Skills in the environment's T3 skills folder, offered to every provider as `$t3:<folder>`. */
export function GlobalSkillsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title?: string | undefined;
}) {
  const { environmentId } = props;
  const disabled = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.disabledGlobalSkills;
  const published = useAtomValue(serverEnvironment.configValueAtom(environmentId), (config) =>
    t3SkillsOf(config?.providers),
  );
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canManage = useAtomValue(globalSkillsEnvironment.rescan.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const rescan = useAtomCommand(globalSkillsEnvironment.rescan, { reportFailure: false });
  const remove = useAtomCommand(globalSkillsEnvironment.remove, { reportFailure: false });
  const [folder, setFolder] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => ReturnType<typeof rescan>) => {
    setPending(true);
    setError(null);
    const result = await call();
    setPending(false);
    if (result._tag === "Failure") return setError(String(squashAtomCommandFailure(result)));
    setFolder(result.value.globalSkillsDir);
  };

  const setEnabled = async (name: string, enabled: boolean) => {
    if (!canWrite || pending) return;
    const next = new Set(disabled ?? []);
    if (enabled) next.delete(name);
    else next.add(name);
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { patch: { disabledGlobalSkills: [...next] } },
    });
    setPending(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };

  const confirmRemove = (skill: ServerProviderSkill) =>
    Dialog.confirm({
      title: `Remove ${skill.name}?`,
      message:
        "This deletes the skill folder from this environment. A linked folder is unlinked and its target stays.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void run(() => remove({ environmentId, input: { name: skill.name } })),
    });

  const disabledSet = new Set(disabled ?? []);
  return (
    <View className="gap-2">
      <ListSection
        title={props.title ? `T3 skills · ${props.title}` : "T3 skills"}
        footer={
          folder
            ? `Skills folder: ${folder}. Call a skill in a message with $t3:<folder-name>.`
            : "Put a skill folder with a SKILL.md in this environment's skills folder, then rescan. Call it in a message with $t3:<folder-name>."
        }
      >
        {published.map((skill) => (
          <View key={skill.name} className="flex-row items-center bg-grouped-card">
            <View className="min-w-0 flex-1">
              <ListRowLayout
                icon="wrench.and.screwdriver"
                label={skill.displayName ? `${skill.displayName} (${skill.name})` : skill.name}
                description={skill.description}
              />
            </View>
            <ThemedSwitch
              accessibilityLabel={`${skill.name} enabled`}
              disabled={!canWrite || pending}
              value={!disabledSet.has(skill.name)}
              onValueChange={(enabled) => void setEnabled(skill.name, enabled)}
            />
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${skill.name}`}
              disabled={!canManage || pending}
              onPress={() => confirmRemove(skill)}
              className="px-4 py-3"
            >
              <SymbolView
                name="trash"
                size={16}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
              />
            </RowPressable>
          </View>
        ))}
        <ListActionRow
          icon="arrow.clockwise"
          label="Rescan"
          loading={pending}
          disabled={!canManage}
          onPress={() => void run(() => rescan({ environmentId, input: {} }))}
        />
      </ListSection>
      {error ? (
        <Text accessibilityRole="alert" textRole="footnote" className="px-2 text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
