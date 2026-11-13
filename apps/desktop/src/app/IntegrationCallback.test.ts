// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - The listener under test is a real Node socket, hit like a browser.
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";

import { cancelIntegrationCallback, receiveIntegrationCallback } from "./IntegrationCallback.ts";

const authorizationUrl = "https://auth.example.com/authorize?client_id=t3&state=s1";

const holdPort = async (requested = 0) => {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(requested, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return { port, release: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

const freePort = async () => {
  const held = await holdPort();
  await held.release();
  return held.port;
};

const redirectFor = (port: number) => `http://127.0.0.1:${port}/integrations/callback`;

describe("receiveIntegrationCallback", () => {
  it("answers only the matching callback and resolves with its full URL", async () => {
    const redirectUri = redirectFor(await freePort());
    const statuses: number[] = [];
    const result = await receiveIntegrationCallback(
      { authorizationUrl, redirectUri },
      async (url) => {
        expect(url).toBe(authorizationUrl);
        for (const path of [
          "/favicon.ico?code=c&state=s1",
          "/integrations/callback?code=c&state=other",
          "/integrations/callback?state=s1",
          "/integrations/callback?code=c&state=s1",
        ]) {
          statuses.push((await fetch(new URL(path, redirectUri))).status);
        }
        return true;
      },
    );
    expect(statuses).toEqual([400, 400, 400, 200]);
    expect(result).toEqual({
      status: "received",
      callbackUrl: `${redirectUri}?code=c&state=s1`,
    });
  });

  it("reports a busy port so the client can ask for another", async () => {
    const held = await holdPort();
    let opened = false;
    const result = await receiveIntegrationCallback(
      { authorizationUrl, redirectUri: redirectFor(held.port) },
      async () => (opened = true),
    );
    await held.release();
    expect(result).toEqual({ status: "port-busy" });
    expect(opened).toBe(false);
  });

  it("stops on cancel and frees the port", async () => {
    const port = await freePort();
    const result = await receiveIntegrationCallback(
      { authorizationUrl, redirectUri: redirectFor(port) },
      async () => {
        cancelIntegrationCallback();
        return true;
      },
    );
    expect(result).toEqual({ status: "cancelled" });
    const again = await holdPort(port);
    await again.release();
    expect(again.port).toBe(port);
  });

  it("hands the port to a sign-in that supersedes the open one", async () => {
    const redirectUri = redirectFor(await freePort());
    const second = Promise.withResolvers<unknown>();
    const first = await receiveIntegrationCallback({ authorizationUrl, redirectUri }, async () => {
      second.resolve(
        receiveIntegrationCallback({ authorizationUrl, redirectUri }, async () => {
          await fetch(`${redirectUri}?code=c&state=s1`);
          return true;
        }),
      );
      return true;
    });
    expect(first).toEqual({ status: "cancelled" });
    expect(await second.promise).toMatchObject({ status: "received" });
  });

  it.each([
    ["an unparseable redirect", "not a url", authorizationUrl],
    ["a non-loopback redirect", "https://example.com/integrations/callback", authorizationUrl],
    ["another path", "http://127.0.0.1:4000/oauth/callback", authorizationUrl],
    ["a non-web sign-in address", "http://127.0.0.1:4000/integrations/callback", "file:///etc"],
  ])("refuses %s", async (_case, redirectUri, authorization) => {
    expect(
      await receiveIntegrationCallback(
        { authorizationUrl: authorization, redirectUri },
        async () => true,
      ),
    ).toEqual({ status: "failed" });
  });

  it("fails when the browser does not open", async () => {
    const result = await receiveIntegrationCallback(
      { authorizationUrl, redirectUri: redirectFor(await freePort()) },
      async () => false,
    );
    expect(result).toEqual({ status: "failed" });
  });
});
