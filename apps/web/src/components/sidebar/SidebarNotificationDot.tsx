import { cn } from "~/lib/utils";

export function SidebarNotificationDot(props: { dotClass: string | null; className?: string }) {
  if (props.dotClass === null) return null;
  return (
    <span
      aria-hidden
      data-testid="sidebar-notification-dot"
      className={cn(
        "pointer-events-none size-1.5 shrink-0 rounded-full",
        props.dotClass,
        props.className,
      )}
    />
  );
}
