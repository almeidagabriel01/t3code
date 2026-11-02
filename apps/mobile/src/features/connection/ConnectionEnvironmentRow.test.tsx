import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("react-native", () => ({
  View: Children,
  Platform: { OS: "ios" },
  Pressable: ({
    children,
    accessible,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button data-accessible={String(accessible !== false)} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: Children },
  FadeIn: {},
  FadeOut: {},
  LinearTransition: { duration: () => ({}) },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@t3tools/client-runtime/connection", () => ({
  hasSavedBearerRoute: () => false,
  hostFreezeNotice: () => null,
}));
vi.mock("@t3tools/contracts", () => ({ resolveEnvironmentMachineKind: () => "server" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({}), updateSettings: {} },
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => ({}) },
}));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("./environmentStatusText", () => ({ environmentStatusText: () => "Connected" }));
vi.mock("./ConnectionTraceId", () => ({ ConnectionTraceId: () => null }));
vi.mock("./ConnectionDiagnosisDetails", () => ({
  ConnectionDiagnosisDetails: () => null,
  useConnectionDiagnosis: () => ({ diagnosis: null, state: "ready" }),
}));
vi.mock("./ConnectionFormField", () => ({ ConnectionFormField: () => null }));
vi.mock("./ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));

import { ConnectionEnvironmentRow } from "./ConnectionEnvironmentRow";

it.each([true, false])("exposes one button per row (opensDetails %s)", (opensDetails) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(
      <ConnectionEnvironmentRow
        environment={
          {
            environmentId: "env",
            environmentLabel: "Mac",
            connectionState: "ready",
            isEnabled: true,
            displayUrl: "",
          } as never
        }
        expanded={false}
        opensDetails={opensDetails}
        onToggle={vi.fn()}
        onReconnect={vi.fn()}
        onRemove={vi.fn()}
        onSetEnabled={vi.fn()}
        onUpdate={vi.fn()}
      />,
    ),
  );
  const buttons = [...host.querySelectorAll("button")];
  expect(buttons.filter((b) => b.dataset.accessible === "true")).toHaveLength(1);
  expect(buttons).toHaveLength(2);
  act(() => root.unmount());
});
