import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { Link, type AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import {
  startMainAppLocationTracking,
  useCloseAppModal,
  useHomeLinkClick,
  useNavigateToMainApp,
  useRememberThreadAsMainApp,
} from "./mainAppLocation";

const THREAD_PATH = "/environment-one/thread-one";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-one"),
  threadId: ThreadId.make("thread-one"),
  messageId: MessageId.make("assistant-one"),
  text: "quoted reply",
  start: 0,
  end: 12,
  prefix: "",
  suffix: "",
};

function ReturnControls() {
  const closeAppModal = useCloseAppModal();
  const navigateToMainApp = useNavigateToMainApp();
  const rememberThread = useRememberThreadAsMainApp();
  const onHomeClick = useHomeLinkClick(false);
  return (
    <>
      <Link to="/" onClick={onHomeClick}>
        Home
      </Link>
      <button
        type="button"
        onClick={() =>
          rememberThread({
            environmentId: EnvironmentId.make("environment-one"),
            threadId: ThreadId.make("thread-b"),
          })
        }
      >
        Select thread B
      </button>
      <button type="button" onClick={() => void closeAppModal()}>
        Close modal
      </button>
      <button type="button" onClick={() => void navigateToMainApp()}>
        Back to app
      </button>
    </>
  );
}

// The tracker records on onResolved, which the router emits only once React commits the page.
async function settled(router: AnyRouter, navigation: Promise<void>) {
  await navigation;
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
}

describe("main app return location", () => {
  it("returns to the thread without re-opening the quote source it was opened at", async () => {
    await using screen = await render(<ReturnControls />, { router: THREAD_PATH });
    const router = screen.router!;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };

    const returnLocation = async (from: string, control: string) => {
      await settled(router, router.navigate(assistantCitationNavigation(citation, null)));
      expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
      await settled(router, router.navigate({ href: from }));
      await userEvent.click(screen.getByRole("button", { name: control }));
      await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
      return router.state.location.href;
    };

    const closingUsage = await returnLocation("/usage", "Close modal");
    const sidebarBack = await returnLocation("/pull-requests", "Back to app");

    expect({ closingUsage, sidebarBack }).toEqual({
      closingUsage: THREAD_PATH,
      sidebarBack: THREAD_PATH,
    });
  });

  // The tracker is module state, so each row starts from a fresh router and ends by resetting it.
  it.each([
    {
      name: "thread, utility page, Home",
      via: ["/activity"],
      select: false,
      control: "Home",
      to: THREAD_PATH,
    },
    {
      name: "thread, Activity, select B, Home",
      via: ["/activity"],
      select: true,
      control: "Home",
      to: "/environment-one/thread-b",
    },
    {
      name: "thread, Activity, select B, back",
      via: ["/activity"],
      select: true,
      control: "Back to app",
      to: "/environment-one/thread-b",
    },
    {
      name: "thread, Settings, Home",
      via: ["/settings"],
      select: false,
      control: "Home",
      to: THREAD_PATH,
    },
    {
      name: "thread, Usage, back",
      via: ["/usage"],
      select: false,
      control: "Back to app",
      to: THREAD_PATH,
    },
  ])("$name", async ({ via, select, control, to }) => {
    await using screen = await render(<ReturnControls />, { router: THREAD_PATH });
    const router = screen.router!;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await settled(router, router.navigate({ href: via[0]! }));
    if (select) await userEvent.click(screen.getByRole("button", { name: "Select thread B" }));
    await userEvent.click(
      screen.getByRole(control === "Home" ? "link" : "button", { name: control }),
    );
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(to));
  });
});
