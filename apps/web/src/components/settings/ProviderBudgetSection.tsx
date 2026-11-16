import { useAtomValue } from "@effect/atom-react";
import { BudgetPeriod, type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, settingCopy } from "./settingsSearch";
import { PROVIDER_SETTINGS_COPY } from "./settingsSearchProviderItems";

const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  daily: "Daily",
  weekly: "Weekly (Mon–Sun)",
  monthly: "Monthly",
};

export function ProviderBudgetSection({
  environmentId,
  instanceId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}) {
  const budget = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))
    ?.providerBudgets?.[instanceId];
  const supported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.providerBudgets === true,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const save = (next: NonNullable<typeof budget> | null) =>
    updateSettings({ providerBudgets: { [instanceId]: next } });
  // A budget keeps the zone it was created in so every device agrees on when periods roll over.
  const timeZone = budget?.timeZone ?? LOCAL_TIME_ZONE;
  const edit = (patch: Partial<NonNullable<typeof budget>>) =>
    budget === undefined ? undefined : save({ ...budget, ...patch });

  // Older servers drop the patch and never enforce it.
  if (!supported) return null;
  return (
    <SettingsSection
      {...searchableSetting("provider-budget")}
      inert={readOnly}
      aria-disabled={readOnly || undefined}
      className={readOnly ? "opacity-50 select-none" : undefined}
      headerAction={
        budget === undefined ? null : (
          <Button size="xs" variant="outline" onClick={() => save(null)}>
            Remove budget
          </Button>
        )
      }
    >
      <SettingsRow
        title={settingCopy("provider-budget-amount").title}
        description={`${PROVIDER_SETTINGS_COPY.budgetPricedPrefix}${timeZone}.`}
        control={
          <DraftInput
            id={`provider-instance-${instanceId}-budget-amount`}
            size="sm"
            inputMode="decimal"
            className="w-28"
            value={budget === undefined ? "" : String(budget.amountUsd)}
            placeholder="No budget"
            onCommit={(value) => {
              const amountUsd = Number(value.trim().replace(/^\$/, ""));
              if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
              if (budget === undefined) {
                save({
                  amountUsd,
                  period: "monthly",
                  warnAtPercent: 80,
                  blockWhenExceeded: false,
                  timeZone,
                });
              } else edit({ amountUsd });
            }}
          />
        }
      />
      {budget === undefined ? null : (
        <>
          <SettingsRow
            title={settingCopy("provider-budget-period").title}
            control={
              <Select
                value={budget.period}
                onValueChange={(value) => {
                  if (BudgetPeriod.literals.includes(value as BudgetPeriod)) {
                    edit({ period: value as BudgetPeriod });
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label="Budget period">
                  <SelectValue>{(value: BudgetPeriod) => BUDGET_PERIOD_LABELS[value]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {BudgetPeriod.literals.map((period) => (
                    <SelectItem key={period} value={period}>
                      {BUDGET_PERIOD_LABELS[period]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...settingCopy("provider-budget-warn")}
            control={
              <DraftInput
                size="sm"
                inputMode="numeric"
                className="w-20"
                value={String(budget.warnAtPercent)}
                onCommit={(value) => {
                  const percent = Number(value);
                  if (Number.isInteger(percent) && percent >= 1 && percent <= 100) {
                    edit({ warnAtPercent: percent });
                  }
                }}
              />
            }
          />
          <SettingsRow
            {...settingCopy("provider-budget-block")}
            control={
              <Switch
                checked={budget.blockWhenExceeded}
                onCheckedChange={(checked) => edit({ blockWhenExceeded: Boolean(checked) })}
                aria-label="Block new turns when exceeded"
              />
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
