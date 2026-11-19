import * as NodeNet from "node:net";
import { describe, expect, it } from "@effect/vitest";

import { listensHere, localPortsIn } from "./localPorts.ts";

describe("localPortsIn", () => {
  it.each([
    ["BASE_URL=http://localhost:5733", [5733]],
    ["--base-url http://127.0.0.1:5733/x", [5733]],
    ["postgres://u:p@[::1]:5432/db", [5432]],
    ["connect ECONNREFUSED ::1:9", [9]],
    ["http://0.0.0.0:3000 and localhost:3001", [3000, 3001]],
    ["https://example.com:443", []],
    ["mylocalhost:80 notlocalhost:81", []],
    ["localhost:99999", []],
  ])("%s", (text, ports) => {
    expect(localPortsIn(text)).toEqual(ports);
  });
});

describe("listensHere", () => {
  it("tells a listening port from a closed one", async () => {
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as NodeNet.AddressInfo;
    expect(listensHere(port)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(listensHere(port)).toBe(false);
  });
});
