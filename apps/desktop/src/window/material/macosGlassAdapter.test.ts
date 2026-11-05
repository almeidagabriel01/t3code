import { assert, it } from "@effect/vitest";
import type { BrowserWindow } from "electron";
import { probeMacosGlass } from "./macosGlassAdapter.ts";
import { fakeObjcRuntime } from "./macosGlassTestFixture.ts";

function windowHandle(handle = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])) {
  const focus = new Set<() => void>();
  const window = {
    isDestroyed: () => false,
    getNativeWindowHandle: () => handle,
    on: (_event: string, listener: () => void) => focus.add(listener),
    off: (_event: string, listener: () => void) => focus.delete(listener),
  } as unknown as BrowserWindow;
  return Object.assign(window, { focus: () => focus.forEach((listener) => listener()) });
}

it.each([
  "alloc-null",
  "init-null",
  "tamic",
  "insert",
  "anchor-null",
  "constraint-null",
  "activation",
  "color-null",
  "tint",
])("%s attachment failure leaves no live view or active constraints", (fail) => {
  const { runtime, state } = fakeObjcRuntime({ fail });
  const adapter = probeMacosGlass(runtime);
  assert.throws(() => adapter.attachSync(windowHandle(), { dark: false, glassOpacity: 80 }));
  assert.equal(state.liveViews.size, 0);
  assert.equal(state.activeConstraints.size, 0);
});

it.each([Buffer.alloc(4), Buffer.alloc(8)])(
  "invalid native handle fails before allocation",
  (handle) => {
    const { runtime, state } = fakeObjcRuntime();
    const adapter = probeMacosGlass(runtime);
    assert.throws(() =>
      adapter.attachSync(windowHandle(handle), { dark: false, glassOpacity: 80 }),
    );
    assert.equal(state.allocations, 0);
  },
);

it("release is idempotent and later updates never message released native objects", () => {
  const { runtime, state } = fakeObjcRuntime();
  const attachment = probeMacosGlass(runtime).attachSync(windowHandle(), {
    dark: true,
    glassOpacity: 40,
  });
  assert.deepEqual(state.tints[0], [0.11, 0.11, 0.12, 0.35]);
  attachment.updateSync({ dark: false, glassOpacity: 100 });
  assert.deepEqual(state.tints.at(-1), [0.96, 0.96, 0.97, 0.85]);
  attachment.releaseSync();
  const mutations = state.mutations;
  attachment.releaseSync();
  attachment.updateSync({ dark: true, glassOpacity: 80 });
  assert.equal(state.mutations, mutations);
  assert.equal(state.liveViews.size, 0);
  assert.equal(state.activeConstraints.size, 0);
});

it("glass ignores window key changes and takes the key look when its window gains focus", () => {
  const { runtime, state } = fakeObjcRuntime();
  const window = windowHandle();
  const attachment = probeMacosGlass(runtime).attachSync(window, { dark: true, glassOpacity: 80 });
  assert.deepEqual(state.allocatedFrom, ["T3KeyStableGlassEffectView"]);
  assert.deepEqual(Object.fromEntries(state.methods), {
    _windowChangedKeyState: "imp:method:NSObject.self",
    t3_applyWindowKeyState: "imp:method:NSGlassEffectView._windowChangedKeyState",
  });
  window.focus();
  assert.equal(state.keyStateApplied, 1);
  attachment.releaseSync();
  window.focus();
  assert.equal(state.keyStateApplied, 1);
  // A second probe in the same process reuses the registered class.
  probeMacosGlass(runtime).attachSync(windowHandle(), { dark: true, glassOpacity: 80 });
  assert.deepEqual(state.allocatedFrom, [
    "T3KeyStableGlassEffectView",
    "T3KeyStableGlassEffectView",
  ]);
});

it("an unknown key-state method keeps plain glass without a focus hook", () => {
  const { runtime, state } = fakeObjcRuntime({ keyStateEncoding: "v24@0:8@16" });
  const window = windowHandle();
  probeMacosGlass(runtime).attachSync(window, { dark: true, glassOpacity: 80 });
  assert.deepEqual(state.allocatedFrom, ["NSGlassEffectView"]);
  assert.equal(state.registered, false);
  window.focus();
  assert.equal(state.keyStateApplied, 0);
});
