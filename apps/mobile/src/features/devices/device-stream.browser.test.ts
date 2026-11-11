import { describe, expect, it, vi } from "vite-plus/test";

import { command, start, stop } from "./device-stream.browser";

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [
    length >>> 24,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload,
  ];
};

function viewerFixture(supported: boolean, extra: Partial<Parameters<typeof start>[0]> = {}) {
  vi.useFakeTimers();
  const configured: string[] = [];
  vi.stubGlobal(
    "VideoDecoder",
    class {
      static isConfigSupported = async () => ({ supported });
      state = "unconfigured";
      decodeQueueSize = 0;
      configure(config: VideoDecoderConfig) {
        configured.push(config.codec);
        this.state = "configured";
      }
      decode() {}
      close() {
        this.state = "closed";
      }
    },
  );
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      send() {}
      close() {}
    },
  );
  const videoBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    requested.push(new URL(url).pathname);
    if (!url.includes("stream.avcc")) return Promise.resolve(new Response(null));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            videoBodies.push(body);
            init.signal?.addEventListener("abort", () => body.error(new Error("aborted")));
          },
        }),
      ),
    );
  });
  const posted: unknown[] = [];
  vi.stubGlobal("ReactNativeWebView", {
    postMessage: (message: string) => posted.push(JSON.parse(message)),
  });
  start({
    platform: "ios",
    deviceId: "sim",
    access: {
      httpBase: "https://environment.test/api/device-hub",
      wsBase: "wss://environment.test/api/device-hub",
      credentials: false,
      query: {},
    },
    colors: {
      background: "black",
      foreground: "white",
      muted: "gray",
      buttonBackground: "black",
      buttonForeground: "white",
      buttonBorder: "gray",
    },
    ...extra,
  });
  return { configured, requested, videoBodies, posted };
}

describe("native iOS simulator viewer", () => {
  it.each([
    { supported: true, image: "" },
    { supported: false, image: "/api/device-hub/vendor/serve-sim/helper/sim/stream.mjpeg" },
  ])(
    "streams H.264 when WebCodecs decodes it, else MJPEG (supported: $supported)",
    async ({ supported, image }) => {
      try {
        const { configured, requested, videoBodies } = viewerFixture(supported);
        await vi.advanceTimersByTimeAsync(0);
        expect(requested).toContain("/api/device-hub/vendor/serve-sim/helper/sim/stream.avcc");
        videoBodies[0]!.enqueue(new Uint8Array(envelope(1, [1, 0x64, 0x00, 0x33])));
        await vi.advanceTimersByTimeAsync(0);
        expect(configured).toEqual(supported ? ["avc1.640033"] : []);
        const img = document.querySelector("img")!;
        expect(img.src && new URL(img.src).pathname).toBe(image);
        expect(img.style.display).toBe(supported ? "none" : "block");
      } finally {
        stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("capture source viewer", () => {
  it.each([
    [{ platform: "desktop" as const }, "Computer screen"],
    [{ platform: "ios" as const }, "iPhone screen"],
  ])("is labelled and never offers input controls (%o)", async (extra, label) => {
    try {
      viewerFixture(true, {
        ...extra,
        serveSimOnly: true,
        videoOnly: true,
        sizeFromConfig: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('[role="application"]')?.getAttribute("aria-label")).toBe(
        label,
      );
      expect(document.querySelector<HTMLElement>('[role="status"]')!.style.display).not.toBe(
        "block",
      );
    } finally {
      stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("controllable captured iPhone viewer", () => {
  it("posts typed text and pasted text before a button, and no touch before video", async () => {
    try {
      const { posted } = viewerFixture(true, {
        serveSimOnly: true,
        videoOnly: true,
        sizeFromConfig: true,
        phoneControl: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      const frame = document.querySelector<HTMLElement>('[role="application"]')!;
      for (const key of ["h", "i", "Shift", "Enter"])
        frame.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
      frame.dispatchEvent(new KeyboardEvent("keyup", { key: "i" }));
      const paste = Object.assign(new Event("paste", { cancelable: true }), {
        clipboardData: { getData: () => "there" },
      });
      frame.dispatchEvent(paste);
      expect(paste.defaultPrevented).toBe(true);
      frame.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1 }));
      command("home");
      command("appSwitcher");
      const inputs = posted.filter(
        (message): message is { type: "phoneInput"; input: unknown } =>
          (message as { type: string }).type === "phoneInput",
      );
      expect(inputs.map((message) => message.input)).toEqual([
        { type: "text", text: "hi\nthere" },
        { type: "button", button: "home" },
        { type: "button", button: "appSwitcher" },
      ]);
    } finally {
      stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
