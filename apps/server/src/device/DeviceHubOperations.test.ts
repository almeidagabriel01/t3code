import { describe, expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { isWifiAdbSerial, makeDeviceHubOperations } from "./DeviceHubOperations.ts";

const hubPhone = (id: string, name: string) => ({
  id,
  name,
  version: "Android 16",
  platform: "android" as const,
  booted: true,
  physical: true,
});

describe("Android phone identity", () => {
  it.each([
    { serial: "192.168.1.20:41233", wifi: true },
    { serial: "pixel.local:5555", wifi: true },
    { serial: "[fe80::1%en0]:5555", wifi: true },
    { serial: "adb-R5CT900-a1B2c3._adb-tls-connect._tcp", wifi: true },
    { serial: "adb-R5CT900-a1B2c3._adb-tls-connect._tcp.", wifi: true },
    { serial: "R5CT900", wifi: false },
    { serial: "emulator-5554", wifi: false },
    { serial: "0123456789ABCDEF", wifi: false },
  ])("$serial is on Wi-Fi: $wifi", ({ serial, wifi }) => {
    expect(isWifiAdbSerial(serial)).toBe(wifi);
  });

  it.effect("names a Wi-Fi phone by its hardware serial and asks adb once per connection", () =>
    Effect.gen(function* () {
      const getprops: Array<string> = [];
      let unreadable = true;
      let listed = [
        hubPhone("R5CT111", "Pixel 9"),
        hubPhone("192.168.1.20:41233", "Pixel 7"),
        hubPhone("192.168.1.30:5555", "Galaxy S24"),
      ];
      const operations = makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://device.test",
        http: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                simulators: [
                  {
                    id: "SIM-1",
                    name: "iPhone 17",
                    version: "iOS 27.0",
                    platform: "ios",
                    booted: true,
                    physical: false,
                  },
                ],
                emulators: [
                  { ...hubPhone("emulator-5554", "Pixel_9_API_36"), physical: false },
                  ...listed,
                ],
              }),
            ),
          ),
        ),
        run: (command, args) =>
          Effect.sync(() => {
            if (command !== "adb") return { code: 0, stdout: "", stderr: "" };
            const serial = args[1]!;
            getprops.push(serial);
            return serial === "192.168.1.30:5555" && unreadable
              ? { code: 1, stdout: "", stderr: "error: device offline" }
              : { code: 0, stdout: "R5CT900\n", stderr: "" };
          }),
        platformAvailable: (platform) => Effect.succeed(platform === "android"),
      });
      const identities = operations.list.pipe(
        Effect.map(({ devices }) =>
          devices.map((device) => [device.id, device.connection, device.identity]),
        ),
      );

      expect(yield* identities).toEqual([
        ["SIM-1", undefined, undefined],
        // A booted emulator goes by its AVD name, which is its id again once it is off.
        ["emulator-5554", undefined, "Pixel_9_API_36"],
        ["R5CT111", "usb", undefined],
        ["192.168.1.20:41233", "wifi", "R5CT900"],
        // A phone whose serial cannot be read is still listed, under its id.
        ["192.168.1.30:5555", "wifi", undefined],
      ]);
      unreadable = false;
      yield* identities;
      // The read serial is kept; only the unread one is asked for again.
      expect(getprops).toEqual(["192.168.1.20:41233", "192.168.1.30:5555", "192.168.1.30:5555"]);

      // The address can pass to another phone once this one is gone, so it is read again.
      listed = [];
      yield* identities;
      listed = [hubPhone("192.168.1.20:41233", "Pixel 7")];
      yield* identities;
      expect(getprops).toHaveLength(4);
    }),
  );
});
