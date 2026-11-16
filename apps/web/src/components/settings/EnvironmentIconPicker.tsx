import {
  AuthSettingsWriteScope,
  ENVIRONMENT_MACHINE_KINDS,
  isEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  SCOPE_ACCESS_CHECKING_MESSAGE,
  SCOPE_ACCESS_UNAVAILABLE_MESSAGE,
} from "@t3tools/client-runtime/state/sessionScope";
import { useEnvironmentScopeAccess } from "../../state/session";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";

const SETTINGS_WRITE_SCOPES = [AuthSettingsWriteScope];

export function resolveEnvironmentIconPickerLock(input: {
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
  readonly operateAccess: "granted" | "denied" | "pending" | "unavailable";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.operateAccess === "pending") {
    return SCOPE_ACCESS_CHECKING_MESSAGE;
  }
  if (input.operateAccess === "unavailable") {
    return SCOPE_ACCESS_UNAVAILABLE_MESSAGE;
  }
  if (input.operateAccess !== "granted") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

export function EnvironmentIconMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const settingsAccess = useEnvironmentScopeAccess(environmentId, SETTINGS_WRITE_SCOPES);
  const operateAccess =
    settingsAccess === "unknown"
      ? "pending"
      : settingsAccess === "missing"
        ? "denied"
        : settingsAccess;
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess });
  const detected = serverConfig?.environment.platform.machine ?? "server";
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  return (
    <MenuSub>
      <MenuSubTrigger>
        <EnvironmentMachineIcon kind={resolved} />
        Icon
      </MenuSubTrigger>
      <MenuSubPopup>
        {lock !== null ? (
          <>
            <MenuItem disabled className="whitespace-normal">
              {lock}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuRadioGroup
          value={resolved}
          onValueChange={(next) => {
            if (lock !== null || !isEnvironmentMachineKind(next)) return;
            updateSettings({ environmentIcon: next === detected ? null : next });
          }}
        >
          {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
            <MenuRadioItem key={kind} value={kind} disabled={lock !== null}>
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon kind={kind} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
                </span>
                {kind === detected ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {serverConfig?.environment.platform.machine ? "detected" : "default"}
                  </span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
