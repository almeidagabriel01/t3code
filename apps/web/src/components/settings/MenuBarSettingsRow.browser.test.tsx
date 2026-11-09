import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { MenuBarSettingsRow } from "./MenuBarSettingsRow";

it("toggles the menu bar icon and offers a reset only when it is off", async () => {
  const onChange = vi.fn();
  await using screen = await render(<MenuBarSettingsRow checked onChange={onChange} />, {
    // The row needs no navigation.
    router: false,
  });
  const toggle = screen.getByRole("switch", { name: "Show in menu bar" });
  await expect.element(toggle).toBeChecked();
  await expect
    .element(screen.getByRole("button", { name: /reset menu bar icon/i }))
    .not.toBeInTheDocument();

  await toggle.click();
  expect(onChange).toHaveBeenLastCalledWith(false);

  await screen.rerender(<MenuBarSettingsRow checked={false} onChange={onChange} />);
  await screen.getByRole("button", { name: /reset menu bar icon/i }).click();
  expect(onChange).toHaveBeenLastCalledWith(true);
});
