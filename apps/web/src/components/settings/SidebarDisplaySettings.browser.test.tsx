import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { SidebarDisplaySettingsRows } from "./SidebarDisplaySettings";

it("switches the Agents section off", async () => {
  const updateSettings = vi.fn();
  await using screen = await render(
    <SidebarDisplaySettingsRows
      settings={DEFAULT_CLIENT_SETTINGS}
      updateSettings={updateSettings}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Show Agents section" }));
  expect(updateSettings).toHaveBeenCalledWith({ sidebarShowAgentsSection: false });
});
