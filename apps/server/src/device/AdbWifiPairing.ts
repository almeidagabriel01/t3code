import { DeviceWifiPairingFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { DeviceHostReady } from "./DeviceHost.ts";

const SCAN_TIMEOUT = Duration.minutes(3);
const CONNECT_TIMEOUT = Duration.minutes(1);
const POLL_INTERVAL = Duration.seconds(1);
// 32 symbols, so a random byte maps to one without bias; none needs escaping in the QR text.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class WifiPairingFailed extends Schema.TaggedError<WifiPairingFailed>()(
  "WifiPairingFailed",
  { reason: DeviceWifiPairingFailure, detail: Schema.optional(Schema.String) },
) {}

const failed = (reason: DeviceWifiPairingFailure, detail?: string) =>
  new WifiPairingFailed({ reason, ...(detail ? { detail } : {}) });

const randomText = (length: number) =>
  Array.from(SecureRandom.randomBytesUnsafe(length), (byte) => ALPHABET[byte % 32]).join("");

export interface WifiPairingSecret {
  readonly serviceName: string;
  readonly password: string;
}

export const newWifiPairingSecret = (): WifiPairingSecret => ({
  serviceName: `ADB_WIFI_${randomText(10)}`,
  password: randomText(10),
});

/** The Wi-Fi QR format Android's "Pair device with QR code" reads. */
export const wifiPairingQrPayload = (secret: WifiPairingSecret) =>
  `WIFI:T:ADB;S:${secret.serviceName};P:${secret.password};;`;

interface MdnsService {
  readonly instance: string;
  readonly type: "pairing" | "connect";
  readonly address: string;
}

/** Lines of `adb mdns services`: instance, service type, address. Other lines are ignored. */
export const parseMdnsServices = (stdout: string): ReadonlyArray<MdnsService> =>
  stdout.split(/\r?\n/).flatMap((line) => {
    const [instance, type, address] = line.trim().split(/\s+/);
    if (!instance || !type || !address || !/:\d+$/.test(address)) return [];
    const kind = /^_adb-tls-pairing\._tcp/.test(type)
      ? "pairing"
      : /^_adb-tls-connect\._tcp/.test(type)
        ? "connect"
        : null;
    return kind ? [{ instance, type: kind, address }] : [];
  });

/** Serials adb reports as ready in `adb devices`. */
const readySerials = (stdout: string) =>
  stdout.split(/\r?\n/).flatMap((line) => {
    const [serial, state] = line.trim().split(/\s+/);
    return serial && state === "device" ? [serial] : [];
  });

const hostOf = (address: string) => address.replace(/:\d+$/, "");

const UNREACHABLE =
  /unable to connect|failed to connect|no route to host|network is unreachable|connection refused|timed out|cannot connect/i;

/**
 * Pairs and connects the phone that scanned `secret`, reporting each step. adb's exit codes
 * are unreliable here, so success is read from what it prints.
 */
export const pairOverWifi = Effect.fn("AdbWifiPairing.pairOverWifi")(function* (
  run: DeviceHostReady["run"],
  secret: WifiPairingSecret,
  onStatus: (status: "pairing" | "connecting") => Effect.Effect<void>,
) {
  const adb = (args: ReadonlyArray<string>, options?: Parameters<typeof run>[2]) =>
    run("adb", args, options).pipe(
      Effect.filterOrFail(
        (result) => result.code !== 127,
        () => failed("adb_missing"),
      ),
    );
  // adb never echoes the code, but a failure line is shown to the user, so scrub it anyway.
  const said = (result: { readonly stdout: string; readonly stderr: string }) =>
    `${result.stdout}\n${result.stderr}`.replaceAll(secret.password, "•••").trim();

  const check = yield* adb(["mdns", "check"]);
  if (!/mdns daemon version/i.test(said(check)))
    return yield* failed("mdns_unavailable", said(check) || undefined);

  const findService = <A>(find: (services: ReadonlyArray<MdnsService>) => A | undefined) =>
    adb(["mdns", "services"]).pipe(
      Effect.map((result) => Option.fromNullishOr(find(parseMdnsServices(result.stdout)))),
    );
  const poll = Effect.fn("AdbWifiPairing.poll")(function* <A, E, R>(
    attempt: Effect.Effect<Option.Option<A>, E, R>,
  ) {
    while (true) {
      const found = yield* attempt;
      if (Option.isSome(found)) return found.value;
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  const pairing = yield* poll(
    findService((services) =>
      services.find(
        (service) => service.type === "pairing" && service.instance === secret.serviceName,
      ),
    ),
  ).pipe(
    Effect.timeoutOption(SCAN_TIMEOUT),
    Effect.flatMap(
      Option.match({ onNone: () => Effect.fail(failed("timeout")), onSome: Effect.succeed }),
    ),
  );

  yield* onStatus("pairing");
  // With no code argument adb reads it from stdin, which keeps it out of the process list.
  const paired = yield* adb(["pair", pairing.address], {
    stdin: `${secret.password}\n`,
    timeoutMs: 30_000,
  });
  const pairText = said(paired);
  if (!/successfully paired/i.test(pairText)) {
    return yield* failed(UNREACHABLE.test(pairText) ? "wrong_network" : "pair_refused", pairText);
  }
  const guid = /\[guid=([^\]\s]+)\]/.exec(pairText)?.[1];
  const phoneHost = hostOf(pairing.address);
  const isPhone = (serial: string) =>
    (guid !== undefined && serial.startsWith(guid)) || hostOf(serial) === phoneHost;

  yield* onStatus("connecting");
  let lastConnect = "";
  // adb usually connects a paired phone itself, by its mDNS name; otherwise connect by address.
  return yield* poll(
    Effect.gen(function* () {
      const listed = yield* adb(["devices"]);
      const serial = readySerials(listed.stdout).find(isPhone);
      if (serial) return Option.some(serial);
      const connect = yield* findService((services) =>
        services.find(
          (service) =>
            service.type === "connect" &&
            ((guid !== undefined && service.instance === guid) ||
              hostOf(service.address) === phoneHost),
        ),
      );
      if (Option.isSome(connect)) {
        const connected = yield* adb(["connect", connect.value.address]);
        lastConnect = said(connected);
        if (/connected to/i.test(lastConnect) && !/failed|unable|cannot/i.test(lastConnect))
          return Option.some(connect.value.address);
      }
      return Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(CONNECT_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(lastConnect ? failed("wrong_network", lastConnect) : failed("timeout")),
        onSome: Effect.succeed,
      }),
    ),
  );
});
