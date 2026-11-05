import * as Effect from "effect/Effect";
import type { ObjcRuntime } from "../../electron/MacosObjcRuntime.ts";
import type { MaterialAdapter, MaterialAppearance } from "./adapters.ts";

const anchors = ["topAnchor", "bottomAnchor", "leadingAnchor", "trailingAnchor"] as const;
// Recorded on macOS 27.2 arm64, ffi-rs 1.3.2 (spike-abi2). JS cannot catch ObjC exceptions:
// verify every dispatch before sending. id/Class/SEL/NSInteger use BigInt, CGFloat Double, BOOL U8.
export const GLASS_ABI = [
  ["NSGlassEffectView", "class", "alloc", "@16@0:8"],
  ["NSGlassEffectView", "instance", "init", "@16@0:8"],
  ["NSGlassEffectView", "instance", "setTranslatesAutoresizingMaskIntoConstraints:", "v20@0:8B16"],
  ["NSGlassEffectView", "instance", "setTintColor:", "v24@0:8@16"],
  ["NSGlassEffectView", "instance", "removeFromSuperview", "v16@0:8"],
  ...anchors.map((name) => ["NSGlassEffectView", "instance", name, "@16@0:8"] as const),
  // Electron's borrowed NSView uses these same inherited anchor implementations.
  ...anchors.map((name) => ["NSView", "instance", name, "@16@0:8"] as const),
  ["NSView", "instance", "addSubview:positioned:relativeTo:", "v40@0:8@16q24@32"],
  ["NSLayoutAnchor", "instance", "constraintEqualToAnchor:", "@24@0:8@16"],
  ["NSLayoutConstraint", "instance", "setActive:", "v20@0:8B16"],
  ["NSObject", "instance", "release", "Vv16@0:8"],
  ["NSThread", "class", "isMainThread", "B16@0:8"],
  ["NSColor", "class", "colorWithSRGBRed:green:blue:alpha:", "@48@0:8d16d24d32d40"],
] as const;

function nonzero(pointer: bigint): bigint {
  if (pointer === 0n) throw new Error("Required AppKit object is unavailable.");
  return pointer;
}

export const KEY_STABLE_GLASS_CLASS = "T3KeyStableGlassEffectView";
export const APPLY_KEY_STATE = "t3_applyWindowKeyState";
const KEY_STATE_ENCODING = "v16@0:8";

// AppKit drops the glass refraction and desaturates it whenever the window loses key status, so
// the app turns pale behind other windows. This subclass ignores that change and exposes the
// original handler as APPLY_KEY_STATE for the focus listener. Null keeps plain glass.
function keyStableGlassClass(runtime: ObjcRuntime, glass: bigint): bigint | null {
  const existing = runtime.classNamed(KEY_STABLE_GLASS_CLASS);
  if (existing !== 0n) return existing;
  try {
    const implementation = (cls: bigint, method: string, encoding: string) => {
      const sel = nonzero(runtime.selector(method));
      if (runtime.encoding(cls, sel, "instance") !== encoding)
        throw new Error("Unsupported AppKit key-state method.");
      const found = nonzero(runtime.function("class_getInstanceMethod", [cls, sel]));
      return nonzero(runtime.function("method_getImplementation", [found]));
    };
    const original = implementation(glass, "_windowChangedKeyState", KEY_STATE_ENCODING);
    const noop = implementation(nonzero(runtime.classNamed("NSObject")), "self", "@16@0:8");
    const subclass = nonzero(
      runtime.function("objc_allocateClassPair", [glass, KEY_STABLE_GLASS_CLASS, 0n]),
    );
    for (const [method, imp] of [
      ["_windowChangedKeyState", noop],
      [APPLY_KEY_STATE, original],
    ] as const)
      runtime.function("class_addMethod", [
        subclass,
        runtime.selector(method),
        imp,
        KEY_STATE_ENCODING,
      ]);
    runtime.function("objc_registerClassPair", [subclass]);
    return subclass;
  } catch {
    return null;
  }
}

export function probeMacosGlass(runtime: ObjcRuntime): MaterialAdapter {
  const classes = new Map<string, bigint>();
  const selectors = new Map<string, bigint>();
  for (const [name, dispatch, method, encoding] of GLASS_ABI) {
    const cls = nonzero(runtime.classNamed(name));
    const sel = nonzero(runtime.selector(method));
    if (runtime.encoding(cls, sel, dispatch) !== encoding)
      throw new Error("Unsupported AppKit method encoding.");
    classes.set(name, cls);
    selectors.set(method, sel);
  }
  const cls = (name: string) => nonzero(classes.get(name) ?? 0n);
  const sel = (name: string) => nonzero(selectors.get(name) ?? 0n);
  const mainThread = () => {
    if (!runtime.bool(cls("NSThread"), sel("isMainThread")))
      throw new Error("AppKit requires the main thread.");
  };
  mainThread();
  const keyStable = keyStableGlassClass(runtime, cls("NSGlassEffectView"));
  const applyKeyState = keyStable === null ? 0n : nonzero(runtime.selector(APPLY_KEY_STATE));
  return {
    kind: "macos-glass",
    prepare: () => Effect.void,
    attachSync: (window, context) => {
      mainThread();
      if (window.isDestroyed()) throw new Error("Cannot attach to a closed window.");
      const handle = window.getNativeWindowHandle();
      if (handle.length !== 8) throw new Error("Unsupported AppKit handle width.");
      const content = nonzero(handle.readBigUInt64LE());
      let glass = nonzero(runtime.pointer(keyStable ?? cls("NSGlassEffectView"), sel("alloc")));
      let owned = true;
      let inserted = false;
      let released = false;
      const constraints: bigint[] = [];
      const tint = ({ dark, glassOpacity }: MaterialAppearance) => {
        // The tint follows light/dark only; custom theme palettes are not sampled.
        const rgba = dark ? [0.11, 0.11, 0.12] : [0.96, 0.96, 0.97];
        const color = nonzero(
          runtime.color(cls("NSColor"), sel("colorWithSRGBRed:green:blue:alpha:"), [
            ...rgba,
            0.35 + (0.5 * (glassOpacity - 40)) / 60,
          ]),
        );
        runtime.void(glass, sel("setTintColor:"), [color]);
      };
      const onFocus = () => {
        if (released) return;
        mainThread();
        runtime.void(glass, applyKeyState);
      };
      const dispose = () => {
        if (keyStable !== null) window.off("focus", onFocus);
        for (const constraint of constraints.splice(0))
          runtime.setBool(constraint, sel("setActive:"), false);
        if (inserted) runtime.void(glass, sel("removeFromSuperview"));
        if (owned && glass !== 0n) runtime.void(glass, sel("release"));
      };
      try {
        // A nil initializer consumes the allocated receiver; it must not be released again.
        glass = runtime.pointer(glass, sel("init"));
        nonzero(glass);
        runtime.setBool(glass, sel("setTranslatesAutoresizingMaskIntoConstraints:"), false);
        // Mark before the call so a JS port failure after insertion also rolls back.
        inserted = true;
        runtime.void(content, sel("addSubview:positioned:relativeTo:"), [glass, -1n, 0n]);
        for (const anchor of anchors) {
          const child = nonzero(runtime.pointer(glass, sel(anchor)));
          const parent = nonzero(runtime.pointer(content, sel(anchor)));
          const constraint = nonzero(
            runtime.pointer(child, sel("constraintEqualToAnchor:"), [parent]),
          );
          constraints.push(constraint);
          runtime.setBool(constraint, sel("setActive:"), true);
        }
        tint(context);
        runtime.void(glass, sel("release"));
        owned = false;
        // Glass attached to a window that is not key starts pale; the first focus fixes it.
        if (keyStable !== null) window.on("focus", onFocus);
      } catch (cause) {
        dispose();
        throw cause;
      }
      return {
        updateSync: (next) => {
          if (released) return;
          mainThread();
          tint(next);
        },
        releaseSync: () => {
          if (released) return;
          mainThread();
          released = true;
          dispose();
        },
      };
    },
  };
}
