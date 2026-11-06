import { GitForkIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { shouldNotifyForkUpdate } from "../forkUpdates/forkUpdates.logic";
import { useForkUpdatesEnvironmentId, useForkUpdateStatus } from "../forkUpdates/useForkUpdates";
import { SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import { cn } from "../../lib/utils";

type ForkUpdatePlacement = "footer" | "rail";

const ANNOUNCED_TAG_KEY = "t3code:fork-update-announced-tag";
// Remembers a fork checkout so the rail shows its entry at startup, before the delayed first check.
const FORK_CHECKOUT_KEY = "t3code:fork-checkout-known";
// The rail and the footer can both mount the pill; one toast per tag per window.
const announcedThisSession = new Set<string>();

/** Says once per upstream tag that the fork is behind; the icon keeps a dot until it is handled. */
export function announceForkUpdate(tag: string, openUpdates: () => void) {
  if (announcedThisSession.has(tag)) return;
  announcedThisSession.add(tag);
  if (getLocalStorageItem(ANNOUNCED_TAG_KEY, Schema.String) === tag) return;
  setLocalStorageItem(ANNOUNCED_TAG_KEY, tag, Schema.String);
  const id = toastManager.add({
    title: `T3 Code ${tag} is out`,
    description: "Your fork is behind this upstream release.",
    timeout: 0,
    actionProps: {
      children: "Update fork",
      onClick: () => {
        toastManager.close(id);
        openUpdates();
      },
    },
    data: { actionLayout: "stacked-end" },
  });
}

function ForkUpdatePill({
  environmentId,
  placement,
}: {
  readonly environmentId: EnvironmentId;
  readonly placement: ForkUpdatePlacement;
}) {
  const navigate = useNavigate();
  const dismissedTag = useClientSettings((settings) => settings.forkUpdatesDismissedTag);
  const { status } = useForkUpdateStatus(environmentId);
  const notifyTag =
    status !== null && shouldNotifyForkUpdate(status, dismissedTag) ? status.upstreamTag : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a toast is an external side effect, raised once when a new upstream tag first appears
  useEffect(() => {
    if (notifyTag !== null) {
      announceForkUpdate(notifyTag, () => void navigate({ to: "/settings/fork-updates" }));
    }
  }, [notifyTag, navigate]);
  const available = status?.available ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- localStorage is external; it lets the next start show the rail entry before its delayed check
  useEffect(() => {
    if (available !== null) setLocalStorageItem(FORK_CHECKOUT_KEY, available, Schema.Boolean);
  }, [available]);
  if (status === null || notifyTag === null) {
    return placement === "rail" && (status?.available ?? knownForkCheckout()) ? (
      <ForkUpdatesLink tag={null} label="Fork updates" />
    ) : null;
  }
  return (
    <ForkUpdatesLink
      tag={notifyTag}
      placement={placement}
      label={`T3 Code ${notifyTag} is out upstream (${status.channel}). Update your fork.`}
    />
  );
}

const knownForkCheckout = () => getLocalStorageItem(FORK_CHECKOUT_KEY, Schema.Boolean) === true;

/** The rail keeps this entry for a fork checkout; the dot and dismiss appear only for a new tag. */
function ForkUpdatesLink({
  tag,
  label,
  placement = "rail",
}: {
  readonly tag: string | null;
  readonly label: string;
  readonly placement?: ForkUpdatePlacement;
}) {
  const inRail = placement === "rail";

  const control = (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/settings/fork-updates"
              aria-label={label}
              className={cn(
                "relative inline-flex cursor-pointer items-center justify-center outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                // Like the update pill: the control fill only while a newer upstream tag waits.
                tag === null
                  ? "text-sidebar-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  : "bg-sidebar-control-surface text-sidebar-foreground",
                inRail
                  ? "size-10 rounded-lg hover:bg-accent"
                  : "size-8 rounded-full hover:bg-sidebar-row-hover",
              )}
            >
              <GitForkIcon className={inRail ? "size-5" : "size-4"} />
              {tag === null ? null : (
                <span
                  aria-hidden
                  data-slot="fork-update-dot"
                  className={cn(
                    "absolute size-2 rounded-full bg-primary ring-2 ring-sidebar",
                    inRail
                      ? "top-1.5 right-1.5 group-hover/fork-update:opacity-0"
                      : "top-0.5 right-0.5",
                  )}
                />
              )}
            </Link>
          }
        />
        <TooltipPopup side={inRail ? "right" : "top"}>{label}</TooltipPopup>
      </Tooltip>
      {tag === null ? null : (
        <button
          type="button"
          aria-label={`Dismiss ${tag}`}
          className={cn(
            "inline-flex cursor-pointer items-center justify-center rounded-full text-(--sidebar-icon-color) hover:text-sidebar-foreground",
            // The rail has no room beside the button, so dismiss sits on its corner while hovered.
            inRail
              ? "absolute -top-1 -right-1 size-4 bg-background opacity-0 group-hover/fork-update:opacity-100 focus-visible:opacity-100"
              : "size-5",
          )}
          onClick={() => void updateClientSettings({ forkUpdatesDismissedTag: tag })}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </>
  );

  return inRail ? (
    <div className="group/fork-update relative flex shrink-0">{control}</div>
  ) : (
    <SidebarMenuItem className="ml-auto flex shrink-0 items-center">{control}</SidebarMenuItem>
  );
}

const FIRST_CHECK_DELAY_MS = 2 * 60_000;

/** True once the delay passed with the page visible, so app start never runs `git fetch`. */
function useAfterStartupDelay() {
  const [ready, setReady] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer and visibility are external
  useEffect(() => {
    let elapsed = false;
    const open = () => {
      if (elapsed && !document.hidden) setReady(true);
    };
    const timer = setTimeout(() => {
      elapsed = true;
      open();
    }, FIRST_CHECK_DELAY_MS);
    document.addEventListener("visibilitychange", open);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", open);
    };
  }, []);
  return ready;
}

/**
 * The rail keeps a Fork updates entry for a fork checkout, with a dot while a newer upstream
 * release is waiting; the footer pill shows only then.
 */
export function SidebarForkUpdatePill({
  placement = "footer",
}: {
  readonly placement?: ForkUpdatePlacement;
}) {
  const environmentId = useForkUpdatesEnvironmentId();
  const ready = useAfterStartupDelay();
  if (environmentId === null) return null;
  if (!ready)
    return placement === "rail" && knownForkCheckout() ? (
      <ForkUpdatesLink tag={null} label="Fork updates" />
    ) : null;
  return <ForkUpdatePill environmentId={environmentId} placement={placement} />;
}
