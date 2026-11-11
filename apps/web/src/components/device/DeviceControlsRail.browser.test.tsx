import type { DevicePlatform } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { DeviceControlsRail } from "./DeviceControlsRail";
import type { DeviceStreamHandle } from "./DeviceStreamView";
import type { DeviceControls } from "./useDeviceControls";

function setup(platform: DevicePlatform, extra: { viewOnly?: boolean } = {}) {
  const handle = {
    pressButton: vi.fn(),
    rotate: vi.fn(),
    inputConnected: true,
  } satisfies DeviceStreamHandle;
  const act = vi.fn(() => Promise.resolve(true));
  const controls = {
    detail: { settings: { appearance: "dark", textSize: "default" } },
    pending: false,
    error: null,
    act,
    disabled: false,
    foregroundApp: null,
  } as unknown as DeviceControls;
  const ui = (
    <div style={{ position: "relative", width: 400, height: 700 }}>
      <DeviceControlsRail
        platform={platform}
        hostKind="local"
        handle={handle}
        view={
          {
            phone: false,
            streaming: true,
            phoneUnavailableReason: null,
            showPhone: vi.fn(),
            showFlat: vi.fn(),
            resetView: vi.fn(),
            keyboard: null,
            handle,
          } satisfies Parameters<typeof DeviceControlsRail>[0]["view"]
        }
        controls={controls}
        screenshotPending={false}
        onScreenshot={vi.fn()}
        toolsOpen={false}
        onTools={vi.fn()}
        onFloat={vi.fn()}
        onClose={vi.fn()}
        {...extra}
      />
    </div>
  );
  return { handle, act, ui };
}

const options = { router: false } as const;

it("an Android rail presses Back and Recents and sets the orientation", async () => {
  const { handle, act, ui } = setup("android");
  await using screen = await render(ui, options);

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await userEvent.click(screen.getByRole("button", { name: "Recents" }));
  expect(handle.pressButton.mock.calls).toEqual([["back"], ["recents"]]);

  await userEvent.click(screen.getByRole("button", { name: "Rotate device" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Portrait" }));
  await userEvent.click(screen.getByRole("button", { name: "Rotate device" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Landscape" }));
  expect(act.mock.calls).toEqual([
    [{ type: "setOrientation", value: "portrait" }],
    [{ type: "setOrientation", value: "landscape_left" }],
  ]);
});

it("an iOS simulator rail rotates, flips appearance and sets the text size", async () => {
  const { handle, act, ui } = setup("ios");
  await using screen = await render(ui, options);

  await userEvent.click(screen.getByRole("button", { name: "Rotate device" }));
  expect(handle.rotate).toHaveBeenCalledOnce();

  await userEvent.click(screen.getByRole("button", { name: "Switch device to light mode" }));
  await userEvent.click(screen.getByRole("button", { name: "Device text size" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Large" }));
  expect(act.mock.calls).toEqual([
    [{ type: "setAppearance", value: "light" }],
    [{ type: "setTextSize", value: "large" }],
  ]);
});

it("a view-only rail hides every input control", async () => {
  const { ui } = setup("android", { viewOnly: true });
  await using screen = await render(ui, options);

  await expect.element(screen.getByRole("button", { name: "More device actions" })).toBeVisible();
  for (const name of ["Home", "Back", "Recents", "Rotate device", "Save screenshot", "3D view"]) {
    expect(screen.getByRole("button", { name }).query()).toBeNull();
  }
});
