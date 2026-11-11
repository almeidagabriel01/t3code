import {
  createDeviceStreamClient,
  type DeviceScreenSize,
} from "@t3tools/client-runtime/device/stream";

import {
  createPhoneGesture,
  createPhoneTextBuffer,
  phoneKeyText,
} from "@t3tools/client-runtime/device/phone-input";

import type { DeviceStreamConfiguration } from "./device-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

let activeClient: ReturnType<typeof createDeviceStreamClient> | null = null;

export function stop() {
  activeClient?.stop();
  activeClient = null;
  phoneButton = null;
}

/** A captured phone's buttons, posted after anything still being typed. */
let phoneButton: ((button: "home" | "appSwitcher") => void) | null = null;

export function command(button: "home" | "back" | "appSwitcher" | "rotate") {
  if (phoneButton && (button === "home" || button === "appSwitcher")) phoneButton(button);
  else if (button === "rotate") activeClient?.rotate();
  else activeClient?.pressButton(button);
}

export function start(configuration: DeviceStreamConfiguration) {
  stop();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
  const post = (message: object) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
  const { colors, platform } = configuration;
  Object.assign(document.documentElement.style, { height: "100%", overflow: "hidden" });
  Object.assign(document.body.style, {
    margin: "0",
    height: "100%",
    overflow: "hidden",
    background: colors.background,
    color: colors.foreground,
    fontFamily: "system-ui",
  });
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    containerType: "size",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  const frame = document.createElement("div");
  frame.setAttribute("role", "application");
  frame.setAttribute(
    "aria-label",
    platform === "desktop"
      ? "Computer screen"
      : platform === "ios"
        ? configuration.videoOnly
          ? "iPhone screen"
          : "iOS Simulator screen"
        : "Android Emulator screen",
  );
  frame.tabIndex = 0;
  Object.assign(frame.style, {
    position: "relative",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTouchCallout: "none",
    outline: "none",
  });
  const canvas = document.createElement("canvas");
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.style.display = "none";
  const inputStatus = document.createElement("div");
  inputStatus.setAttribute("role", "status");
  inputStatus.textContent = "Reconnecting device controls...";
  Object.assign(inputStatus.style, {
    position: "fixed",
    bottom: "12px",
    left: "0",
    right: "0",
    textAlign: "center",
    pointerEvents: "none",
    fontSize: "13px",
    color: colors.muted,
    background: colors.background,
  });
  frame.append(canvas, image);
  container.append(frame);
  document.body.replaceChildren(container, inputStatus);

  const phoneControl = configuration.phoneControl === true;
  const viewOnly = configuration.videoOnly === true && !phoneControl;
  const sendPhoneInput = (input: object) => {
    if (activeClient === client) post({ type: "phoneInput", input });
  };
  const phoneGesture = createPhoneGesture(sendPhoneInput);
  const phoneText = createPhoneTextBuffer(sendPhoneInput);
  phoneButton = phoneControl
    ? (button) => {
        phoneText.flush();
        sendPhoneInput({ type: "button", button });
      }
    : null;
  let pointerId: number | null = null;
  let inputConnected = false;
  let streaming = false;
  const reportStatus = (status: "connecting" | "streaming" | "error", detail?: string) => {
    if (activeClient !== client) return;
    streaming = status === "streaming";
    inputStatus.style.display =
      streaming && !inputConnected && !viewOnly && !phoneControl ? "block" : "none";
    post({ type: "status", status, detail });
  };
  const layout = (screen: DeviceScreenSize | null) => {
    const landscape =
      screen?.orientation === "landscape_left" || screen?.orientation === "landscape_right";
    const aspect = screen
      ? landscape
        ? Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height)
        : Math.min(screen.width, screen.height) / Math.max(screen.width, screen.height)
      : 9 / 19.5;
    const rotation =
      platform === "ios" && screen && screen.width <= screen.height
        ? screen.orientation === "landscape_left"
          ? 90
          : screen.orientation === "landscape_right"
            ? -90
            : screen.orientation === "portrait_upside_down"
              ? 180
              : 0
        : 0;
    const sideways = Math.abs(rotation) === 90;
    frame.style.width = `min(100cqw, ${aspect * 100}cqh)`;
    frame.style.height = `min(100cqh, ${100 / aspect}cqw)`;
    for (const media of [canvas, image]) {
      Object.assign(media.style, {
        position: "absolute",
        width: sideways ? `${100 / aspect}%` : "100%",
        height: sideways ? `${100 * aspect}%` : "100%",
        left: "50%",
        top: "50%",
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        pointerEvents: "none",
      });
    }
  };
  layout(null);
  const unauthorized = () => {
    if (activeClient === client) post({ type: "unauthorized" });
  };
  const client = createDeviceStreamClient(configuration, canvas, {
    onStatus: reportStatus,
    onScreen: layout,
    onMjpegFallback: () => {
      canvas.style.display = "none";
      image.style.display = "block";
    },
    onCanvasVideo: () => {
      image.style.display = "none";
      canvas.style.display = "";
    },
    onUnauthorized: unauthorized,
    onInputConnected: (connected) => {
      inputConnected = connected;
      inputStatus.style.display =
        streaming && !connected && !viewOnly && !phoneControl ? "block" : "none";
      post({ type: "input", connected });
    },
  });
  activeClient = client;
  client.setMjpegImage(image);
  const touch = (event: PointerEvent, phase: "begin" | "move" | "end") => {
    const rect = frame.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    if (!phoneControl) client.sendTouch(phase, x, y);
    else {
      if (phase === "begin") phoneText.flush();
      phoneGesture.touch(phase, x, y);
    }
  };
  frame.addEventListener("pointerdown", (event) => {
    if (!(phoneControl ? streaming : inputConnected) || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    frame.setPointerCapture(event.pointerId);
    frame.focus();
    touch(event, "begin");
  });
  frame.addEventListener("pointermove", (event) => {
    if (pointerId === event.pointerId) touch(event, "move");
  });
  const endTouch = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    touch(event, "end");
  };
  frame.addEventListener("pointerup", endTouch);
  frame.addEventListener("pointercancel", endTouch);
  frame.addEventListener("lostpointercapture", endTouch);
  frame.addEventListener("keydown", (event) => {
    if (!phoneControl) {
      event.preventDefault();
      client.sendKey(event, "down");
      return;
    }
    const text = phoneKeyText(event);
    if (text === null) return;
    event.preventDefault();
    phoneText.add(text);
  });
  frame.addEventListener("keyup", (event) => {
    if (!phoneControl) client.sendKey(event, "up");
  });
  frame.addEventListener("paste", (event) => {
    if (!phoneControl) return;
    event.preventDefault();
    phoneText.add(event.clipboardData?.getData("text/plain") ?? "");
  });
  window.addEventListener("pagehide", stop, { once: true });
  post({ type: "input", connected: false });
  client.start();
}
