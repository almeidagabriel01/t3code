import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));

import { OverlayPortal, OverlayPortalHost, OverlayPortalScope } from "./OverlayPortal";

it("draws an overlay opened inside a sheet in the sheet, never at the app root", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <>
        <section data-testid="app-root">
          <OverlayPortalHost />
        </section>
        <section data-testid="sheet">
          <OverlayPortalScope>
            <OverlayPortal>sheet menu</OverlayPortal>
          </OverlayPortalScope>
        </section>
        <OverlayPortal>root menu</OverlayPortal>
      </>,
    ),
  );

  const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)!.textContent;
  expect(text("sheet")).toBe("sheet menu");
  expect(text("app-root")).toBe("root menu");
  act(() => root.unmount());
});
