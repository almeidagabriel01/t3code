import type { DesktopOpenAtLoginState } from "@t3tools/contracts";
import { LogInIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { OPEN_AT_LOGIN_FAILED, openAtLoginRowView } from "./OpenAtLoginSettingsRow.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function OpenAtLoginSettingsRow() {
  const bridge = window.desktopBridge;
  const [state, setState] = useState<DesktopOpenAtLoginState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the OS login item, which the user can change in system settings while T3 Code is open.
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const refresh = () => {
      void bridge.getOpenAtLogin().then(
        (next) => {
          if (active) setState(next);
        },
        () => undefined,
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [bridge]);

  if (!bridge || state === null) return null;
  const view = openAtLoginRowView(state);

  const change = (enabled: boolean) => {
    setPending(true);
    setError(null);
    bridge
      .setOpenAtLogin(enabled)
      .then(
        (next) => {
          if (next) setState(next);
        },
        () => setError(OPEN_AT_LOGIN_FAILED),
      )
      .finally(() => setPending(false));
  };

  return (
    <SettingsRow
      {...searchableSetting("open-at-login")}
      description={view.description}
      status={
        (error ?? view.notice) ? (
          <span className="text-warning-foreground">{error ?? view.notice}</span>
        ) : undefined
      }
      control={
        <>
          {view.canOpenSystemSettings ? (
            <Button
              variant="outline"
              size="compact"
              onClick={() => void bridge.openLoginItemsSettings()}
            >
              <LogInIcon />
              Open System Settings
            </Button>
          ) : null}
          <Switch
            checked={view.checked}
            disabled={pending}
            onCheckedChange={(next) => change(Boolean(next))}
            aria-label="Open at login"
          />
        </>
      }
    />
  );
}
