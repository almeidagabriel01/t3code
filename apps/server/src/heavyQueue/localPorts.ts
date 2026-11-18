// @effect-diagnostics nodeBuiltinImport:off - Read by the plain-Node queue file and CLI.
import * as NodeChildProcess from "node:child_process";

const LOCAL_PORT =
  /(?:^|[^\w.-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):(\d{1,5})(?!\d)/g;

/** The ports a text names on this machine's loopback (`localhost:5173`, `127.0.0.1:5432`, …). */
export const localPortsIn = (text: string): ReadonlyArray<number> =>
  [...text.matchAll(LOCAL_PORT)]
    .map((match) => Number(match[1]))
    .filter((port) => port > 0 && port < 65_536);

/** Whether a process on this Mac listens on TCP `port`; false when `lsof` can't tell. */
export const listensHere = (port: number) => {
  try {
    const pids = NodeChildProcess.execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      },
    );
    return pids.trim() !== "";
  } catch {
    // lsof exits 1 when nothing listens.
    return false;
  }
};
