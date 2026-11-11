import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  newWifiPairingSecret,
  pairOverWifi,
  parseMdnsServices,
  wifiPairingQrPayload,
} from "./AdbWifiPairing.ts";
import type { DeviceHostReady } from "./DeviceHost.ts";

const secret = { serviceName: "ADB_WIFI_TESTNAME01", password: "PASSWORD22" };
const PAIRING_LINE = `${secret.serviceName}\t_adb-tls-pairing._tcp.\t192.168.1.20:37111`;
const CONNECT_LINE = "adb-R5CT900-AbCdEf\t_adb-tls-connect._tcp.\t192.168.1.20:41233";
const PAIRED = "Successfully paired to 192.168.1.20:37111 [guid=adb-R5CT900-AbCdEf]";
const READY = "check: mdns daemon version [Openscreen discovery 0.0.0]";

/** A scripted adb: each list answers its calls in order and repeats its last answer. */
const fakeAdb = (script: {
  readonly missing?: boolean;
  readonly check?: string;
  readonly services?: ReadonlyArray<string>;
  readonly pair?: string;
  /** Exit codes for `pair` and `connect`; 124 is a command that hung. */
  readonly codes?: Readonly<Record<string, number>>;
  readonly devices?: ReadonlyArray<string>;
  readonly connect?: string;
}) => {
  const calls: Array<{ readonly args: ReadonlyArray<string>; readonly stdin?: string }> = [];
  const counts = new Map<string, number>();
  const next = (key: string, answers: ReadonlyArray<string> | undefined) => {
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    return answers?.[Math.min(index, answers.length - 1)] ?? "";
  };
  const run: DeviceHostReady["run"] = (command, args, options) =>
    Effect.sync(() => {
      calls.push({ args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) });
      if (command !== "adb" || script.missing)
        return { code: 127, stdout: "", stderr: "spawn adb ENOENT" };
      const answers: Record<string, () => string> = {
        "mdns check": () => script.check ?? READY,
        "mdns services": () =>
          `List of discovered mdns services\n${next("services", script.services)}`,
        pair: () => script.pair ?? PAIRED,
        devices: () => `List of devices attached\n${next("devices", script.devices)}`,
        connect: () => script.connect ?? "",
      };
      const stdout = answers[args[0] === "mdns" ? args.join(" ") : (args[0] ?? "")]?.() ?? "";
      return { code: script.codes?.[args[0] ?? ""] ?? 0, stdout, stderr: "" };
    });
  return { run, calls };
};

const pair = Effect.fn("pair")(function* (
  adb: ReturnType<typeof fakeAdb>,
  advance: Parameters<typeof TestClock.adjust>[0] = "1 second",
) {
  const statuses: Array<string> = [];
  const fiber = yield* pairOverWifi(adb.run, secret, (status) =>
    Effect.sync(() => void statuses.push(status)),
  ).pipe(
    Effect.catchTags({ WifiPairingFailed: (error) => Effect.succeed(`failed: ${error.reason}`) }),
    Effect.forkChild,
  );
  yield* TestClock.adjust(advance);
  return { result: yield* Fiber.join(fiber), statuses };
});

describe("Wi-Fi pairing", () => {
  it("encodes the QR Android's Pair device with QR code reads", () => {
    expect(wifiPairingQrPayload(secret)).toBe("WIFI:T:ADB;S:ADB_WIFI_TESTNAME01;P:PASSWORD22;;");
    const fresh = newWifiPairingSecret();
    expect(wifiPairingQrPayload(fresh)).toMatch(
      /^WIFI:T:ADB;S:ADB_WIFI_[A-Z2-9]{10};P:[A-Z2-9]{10};;$/,
    );
    expect(newWifiPairingSecret().password).not.toBe(fresh.password);
  });

  it("reads mDNS services with or without the trailing dot and skips other lines", () => {
    expect(
      parseMdnsServices(
        [
          "List of discovered mdns services",
          PAIRING_LINE,
          "adb-R5CT900-AbCdEf  _adb-tls-connect._tcp  192.168.1.20:41233",
          "printer\t_ipp._tcp\t192.168.1.9:631",
          "garbage",
        ].join("\n"),
      ),
    ).toEqual([
      { instance: secret.serviceName, type: "pairing", address: "192.168.1.20:37111" },
      { instance: "adb-R5CT900-AbCdEf", type: "connect", address: "192.168.1.20:41233" },
    ]);
  });

  it.effect("pairs once the phone scans and takes the connection adb makes itself", () =>
    Effect.gen(function* () {
      const adb = fakeAdb({
        services: ["", PAIRING_LINE],
        devices: ["adb-R5CT900-AbCdEf._adb-tls-connect._tcp\tdevice"],
      });
      const { result, statuses } = yield* pair(adb);
      expect(result).toBe("adb-R5CT900-AbCdEf._adb-tls-connect._tcp");
      expect(statuses).toEqual(["pairing", "connecting"]);
      // The password goes to adb on stdin only: never in an argument.
      expect(adb.calls.find((call) => call.args[0] === "pair")).toEqual({
        args: ["pair", "192.168.1.20:37111"],
        stdin: `${secret.password}\n`,
      });
      expect(adb.calls.some((call) => call.args.join(" ").includes(secret.password))).toBe(false);
    }),
  );

  it.effect("connects by address when adb does not connect the paired phone itself", () =>
    Effect.gen(function* () {
      const adb = fakeAdb({
        services: [PAIRING_LINE, `${PAIRING_LINE}\n${CONNECT_LINE}`],
        devices: ["", "192.168.1.20:41233\tdevice"],
        connect: "connected to 192.168.1.20:41233",
      });
      const { result } = yield* pair(adb);
      expect(result).toBe("192.168.1.20:41233");
      expect(adb.calls.map((call) => call.args[0])).toContain("connect");
    }),
  );

  it.effect.each([
    { failure: "adb_missing", script: { missing: true } },
    { failure: "mdns_unavailable", script: { check: "ERROR: mdns daemon unavailable" } },
    // Nobody scans: the attempt gives up after three minutes.
    { failure: "timeout", script: { services: [""] }, advance: "3 minutes" },
    {
      failure: "wrong_network",
      script: {
        services: [PAIRING_LINE],
        pair: "error: unable to connect to 192.168.1.20:37111: No route to host",
      },
    },
    {
      failure: "pair_refused",
      script: {
        services: [PAIRING_LINE],
        pair: "Failed: Wrong password or connection was dropped.",
      },
    },
    // The phone answers mDNS but not TCP, so adb pair hangs and says nothing.
    {
      failure: "wrong_network",
      script: { services: [PAIRING_LINE], pair: "", codes: { pair: 124 } },
    },
    {
      failure: "wrong_network",
      script: {
        services: [`${PAIRING_LINE}\n${CONNECT_LINE}`],
        connect: "",
        codes: { connect: 124 },
      },
      advance: "1 minute",
    },
    // Paired, but the phone's connect address cannot be reached.
    {
      failure: "wrong_network",
      script: {
        services: [`${PAIRING_LINE}\n${CONNECT_LINE}`],
        connect: "failed to connect to 192.168.1.20:41233",
      },
      advance: "1 minute",
    },
    // Paired, but the phone never offers a connection.
    { failure: "timeout", script: { services: [PAIRING_LINE] }, advance: "1 minute" },
  ] as const)("fails with $failure", ({ failure, script, ...rest }) =>
    Effect.gen(function* () {
      const advance = "advance" in rest ? rest.advance : "1 second";
      expect((yield* pair(fakeAdb(script), advance)).result).toBe(`failed: ${failure}`);
    }),
  );
});
