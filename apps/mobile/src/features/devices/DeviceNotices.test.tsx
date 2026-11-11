import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { DeviceNotices } from "./DeviceNotices";
import { deviceIssueRows, type ThreadDevicePreview } from "./threadDevicePreviews";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));

const render = async (preview: ThreadDevicePreview | null) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<DeviceNotices preview={preview} />));
  const lines = [...container.querySelectorAll("p")].map((line) => line.textContent);
  await act(async () => root.unmount());
  return lines;
};

const preview = (fields: Pick<ThreadDevicePreview, "viewOnlyNotice" | "issues">) =>
  fields as ThreadDevicePreview;

describe("DeviceNotices", () => {
  it("shows the view-only notice and the issues that still let the user watch", async () => {
    expect(
      await render(
        preview({
          viewOnlyNotice: "View only. Use the phone to control it.",
          issues: deviceIssueRows({
            issues: [{ reason: "signing_missing" }, { reason: "locked" }],
          }),
        }),
      ),
    ).toEqual([
      "View only. Use the phone to control it.",
      "iPhone signing is not set up. Add your Apple Team ID in Settings > Devices > iPhone signing.",
    ]);
  });

  it("shows nothing for a simulator, or with no device", async () => {
    expect(await render(preview({ viewOnlyNotice: null, issues: [] }))).toEqual([]);
    expect(await render(null)).toEqual([]);
  });
});
