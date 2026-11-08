import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProviderSkill } from "@t3tools/contracts";
import { t3SkillsOf } from "@t3tools/client-runtime/state/global-skills";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { globalSkillsEnvironment } from "../../state/globalSkills";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function GlobalSkillsSettings() {
  const { environment, scope } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  return (
    <SettingsSection {...searchableSetting("t3-skills")}>
      {connected && environment ? (
        <SkillList
          key={environment.environmentId}
          environmentId={environment.environmentId}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
        />
      ) : (
        <SettingsRow
          title="T3 skills"
          description="Connect an environment to manage its T3 skills."
        />
      )}
    </SettingsSection>
  );
}

function SkillList({
  environmentId,
  projectScoped,
}: {
  environmentId: EnvironmentId;
  projectScoped: boolean;
}) {
  const disabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.disabledGlobalSkills,
  );
  const published = useAtomValue(serverEnvironment.configValueAtom(environmentId), (config) =>
    t3SkillsOf(config?.providers),
  );
  const canWrite =
    useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId)) && !projectScoped;
  const canManage = useAtomValue(globalSkillsEnvironment.rescan.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const rescan = useAtomCommand(globalSkillsEnvironment.rescan, { reportFailure: false });
  const remove = useAtomCommand(globalSkillsEnvironment.remove, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "skills folder path" });
  const [folder, setFolder] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ServerProviderSkill | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => ReturnType<typeof rescan>) => {
    setPending(true);
    setError(null);
    const result = await call();
    setPending(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return false;
    }
    setFolder(result.value.globalSkillsDir);
    return true;
  };

  const setEnabled = async (name: string, enabled: boolean) => {
    if (!canWrite || pending) return;
    const current = new Set(disabled ?? []);
    if (enabled) current.delete(name);
    else current.add(name);
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { patch: { disabledGlobalSkills: [...current] } },
    });
    setPending(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
  };

  const disabledSet = new Set(disabled ?? []);
  return (
    <>
      <SettingsRow
        title="Skills folder"
        description={
          <span>
            Put a skill folder with a SKILL.md in this environment's skills folder, then rescan.
            Call it in a message with $t3:&lt;folder-name&gt;.
            <br />
            {folder ? <code>{folder}</code> : "Rescan to show the folder path."}
          </span>
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!folder}
              onClick={() => folder && copyToClipboard(folder, undefined)}
            >
              {isCopied ? "Copied" : "Copy path"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || pending}
              onClick={() => void run(() => rescan({ environmentId, input: {} }))}
            >
              Rescan
            </Button>
          </div>
        }
      />
      {published.length === 0 ? (
        <SettingsRow title="No T3 skills yet" description="Add a skill folder, then rescan." />
      ) : null}
      {published.map((skill) => (
        <SettingsRow
          key={skill.name}
          title={skill.displayName ? `${skill.displayName} (${skill.name})` : skill.name}
          description={skill.description ?? skill.path}
          control={
            <div className="flex items-center gap-2">
              <Switch
                aria-label={`Enable ${skill.name}`}
                checked={!disabledSet.has(skill.name)}
                disabled={!canWrite || pending}
                onCheckedChange={(enabled) => void setEnabled(skill.name, enabled)}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={!canManage || pending}
                onClick={() => setRemoving(skill)}
              >
                Remove
              </Button>
            </div>
          }
        />
      ))}
      {projectScoped ? (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Environment-wide setting. Select an environment to turn skills on or off.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the skill folder from this environment. A linked folder is unlinked and
              its target stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                const target = removing;
                if (target)
                  void run(() => remove({ environmentId, input: { name: target.name } })).then(
                    (ok) => {
                      if (ok) setRemoving(null);
                    },
                  );
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
