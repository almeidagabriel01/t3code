import type { EnvironmentId } from "@t3tools/contracts";
import type { ParsedSettingsLink } from "@t3tools/shared/settingsLinks";
import { useRouter } from "@tanstack/react-router";
import type { ComponentProps } from "react";

/** Opens the linked settings page in the app; a page this client lacks opens Settings. */
export function MarkdownSettingsLink({
  link,
  environmentId,
  ...props
}: Omit<ComponentProps<"a">, "href" | "onClick"> & {
  readonly link: ParsedSettingsLink;
  readonly environmentId: EnvironmentId | null;
}) {
  const router = useRouter();
  const page = link.page === null ? null : `/settings/${link.page}`;
  const path = page !== null && page in router.routesByPath ? page : "/settings";
  const search = new URLSearchParams();
  const machine = link.environmentId ?? environmentId;
  if (machine !== null) search.set("machine", machine);
  if (link.entry !== null && path !== "/settings") search.set("entry", link.entry);
  const href = search.size > 0 ? `${path}?${search}` : path;
  return (
    <a
      {...props}
      href={router.history.createHref(href)}
      onClick={(event) => {
        // Desktop would hand a new window to the OS browser, so every click stays in the app.
        event.preventDefault();
        void router.navigate({ href });
      }}
    />
  );
}
