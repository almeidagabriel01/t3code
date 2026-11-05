import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useAssistantsEnvironmentIds } from "../../state/assistants";

/** The pause switch of the first environment that runs assistants; null when none does. */
export function useAutonomyPause() {
  const environmentId = useAssistantsEnvironmentIds()[0] ?? null;
  const autonomy = useEnvironmentSettings(
    (environmentId ?? "") as EnvironmentId,
    (settings) => settings.autonomy,
  );
  const update = useUpdateEnvironmentSettings(environmentId);
  if (environmentId === null) return null;
  return {
    enabled: autonomy.enabled,
    toggle: () => update({ autonomy: { ...autonomy, enabled: !autonomy.enabled } }),
  };
}
