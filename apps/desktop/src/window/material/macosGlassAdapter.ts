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

const BOOL_GETTER = "B16@0:8";

// AppKit draws glass in its inactive look (no refraction, desaturated) while its window is not key,
// so the app turned pale behind other windows. Electron's window class reports an active appearance
// instead; NSWindow itself is never patched. The YES comes from -[NSArray isNSArray__], a constant
// BOOL getter. Any mismatch keeps the stock behavior.
function keepActiveAppearance(runtime: ObjcRuntime, content: bigint) {
  try {
    const getter = (name: string) => nonzero(runtime.selector(name));
    const implementation = (cls: bigint, sel: bigint) => {
      const method = runtime.function("class_getInstanceMethod", [cls, sel]);
      return method === 0n ? 0n : runtime.function("method_getImplementation", [method]);
    };
    const view = nonzero(runtime.classNamed("NSView"));
    if (runtime.encoding(view, getter("window"), "instance") !== "@16@0:8") return;
    const window = nonzero(runtime.pointer(content, getter("window")));
    const windowClass = nonzero(runtime.function("object_getClass", [window]));
    if (windowClass === runtime.classNamed("NSWindow")) return;
    const active = getter("_hasActiveAppearance");
    if (runtime.encoding(windowClass, active, "instance") !== BOOL_GETTER) return;
    const yes = getter("isNSArray__");
    const array = nonzero(runtime.classNamed("NSArray"));
    if (runtime.encoding(array, yes, "instance") !== BOOL_GETTER) return;
    const alwaysYes = nonzero(implementation(array, yes));
    if (alwaysYes === implementation(nonzero(runtime.classNamed("NSObject")), yes)) return;
    // NO when an earlier window already added it, which leaves the same override in place.
    runtime.function("class_addMethod", [windowClass, active, alwaysYes, BOOL_GETTER]);
  } catch {
    // Stock behavior: inactive windows show the inactive glass.
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
  return {
    kind: "macos-glass",
    prepare: () => Effect.void,
    attachSync: (window, context) => {
      mainThread();
      if (window.isDestroyed()) throw new Error("Cannot attach to a closed window.");
      const handle = window.getNativeWindowHandle();
      if (handle.length !== 8) throw new Error("Unsupported AppKit handle width.");
      const content = nonzero(handle.readBigUInt64LE());
      let glass = nonzero(runtime.pointer(cls("NSGlassEffectView"), sel("alloc")));
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
      const dispose = () => {
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
        keepActiveAppearance(runtime, content);
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
