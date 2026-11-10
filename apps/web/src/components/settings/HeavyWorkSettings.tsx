import { PRIORITY_LABEL, projectForCwd } from "@t3tools/client-runtime/state/heavyQueueModel";
import type { EnvironmentId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { useHeavyQueue } from "../../state/heavyQueue";
import { useHeavyQueueActions } from "../statusBar/useKillTarget";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LIMITS = [1, 2, 3, 4, 6, 8] as const;

function Controls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useHeavyQueue(environmentId);
  const actions = useHeavyQueueActions(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const locked = !actions.canChange || !state.enabled;
  return (
    <>
      <SettingsRow
        {...searchableSetting("heavy-work-enabled")}
        description="On: tests, builds and simulators take turns, and agents ask before adding to a busy machine. Off: heavy jobs start right away and agents do not ask first."
        control={
          <Switch
            checked={state.enabled}
            disabled={!actions.canChange}
            onCheckedChange={(checked) => void actions.setEnabled(Boolean(checked))}
            aria-label="Use the heavy work queue"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("heavy-work-max")}
        description="Tests, builds and simulators wait here. With 1, they run strictly one at a time. With more, the next one starts only when the machine has room for it."
        control={
          <Select
            value={String(state.maxRunning)}
            onValueChange={(next) => {
              if (next !== null) void actions.setMaxRunning(Number(next));
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-24"
              aria-label="Run up to this many heavy jobs at once"
              disabled={locked}
            >
              <SelectValue>{String(state.maxRunning)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {LIMITS.map((limit) => (
                <SelectItem hideIndicator key={limit} value={String(limit)}>
                  {limit}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("heavy-work-pause")}
        description="While paused nothing new starts. Jobs already running continue."
        control={
          <Switch
            checked={state.paused}
            disabled={locked}
            onCheckedChange={(checked) => void actions.setPaused(Boolean(checked))}
            aria-label="Pause the heavy work queue"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("heavy-work-rules")}
        description={
          state.rules.length === 0
            ? "No project has a fixed priority. Set one from a queued job's menu in the Resource Manager."
            : "Jobs from these projects go ahead of, or behind, the others. Jobs already queued keep their place."
        }
      >
        <ul className="pb-2">
          {state.rules.map((rule) => {
            const project = projectForCwd(projects, rule.root);
            return (
              <li key={rule.root} className="flex items-center gap-2 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate">{project?.title ?? rule.root}</span>
                <span className="shrink-0 text-muted-foreground">
                  {PRIORITY_LABEL[rule.priority]}
                </span>
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label={`Remove the priority rule for ${project?.title ?? rule.root}`}
                  disabled={locked}
                  onClick={() => void actions.setRule(rule.root, null)}
                >
                  <XIcon aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      </SettingsRow>
    </>
  );
}

export function HeavyWorkSettingsSection() {
  const { scope, environment } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  return (
    <SettingsSection id="heavy-work" title="Heavy work">
      {environmentId === null ? (
        <SettingsRow
          title="Heavy work queue"
          description="Choose one environment to manage its queue."
        />
      ) : (
        <Controls environmentId={environmentId} />
      )}
    </SettingsSection>
  );
}
