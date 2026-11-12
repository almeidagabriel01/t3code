import { describe, expect, it } from "@effect/vitest";

import { checkedLookup, makeGuardedFetch, UnsafeAddressError } from "./IntegrationFetch.ts";

const answers: Record<string, ReadonlyArray<{ address: string; family: number }>> = {
  "public.test": [{ address: "93.184.216.34", family: 4 }],
  "private.test": [{ address: "10.0.0.7", family: 4 }],
  "mixed.test": [
    { address: "93.184.216.34", family: 4 },
    { address: "192.168.1.2", family: 4 },
  ],
  "metadata.test": [{ address: "169.254.169.254", family: 4 }],
  "v6-loopback.test": [{ address: "::1", family: 6 }],
  "v4-mapped.test": [{ address: "::ffff:127.0.0.1", family: 6 }],
  "localhost.test": [{ address: "127.0.0.1", family: 4 }],
};
const resolve = async (host: string) => answers[host] ?? [];

const recording = (respond: (url: URL) => Response = () => new Response("ok")) => {
  const sent: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
  const send = async (input: string | URL, init?: RequestInit) => {
    sent.push({ url: String(input), redirect: init?.redirect });
    return respond(new URL(input));
  };
  return { sent, fetch: makeGuardedFetch(send, resolve) };
};

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

describe("makeGuardedFetch", () => {
  it.each([
    "http://public.test/x",
    "https://user:pass@public.test/x",
    "https://private.test/x",
    "https://mixed.test/x",
    "https://metadata.test/x",
    "https://v6-loopback.test/x",
    "https://v4-mapped.test/x",
    "https://localhost.test/x",
    "https://unresolvable.test/x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://[::1]/x",
    "https://[fe80::1]/x",
  ])("refuses %s before sending anything", async (url) => {
    const { sent, fetch } = recording();
    await expect(fetch(url)).rejects.toBeInstanceOf(UnsafeAddressError);
    expect(sent).toEqual([]);
  });

  it("sends to a public https address without following redirects itself", async () => {
    const { sent, fetch } = recording();
    expect(await (await fetch("https://public.test/x")).text()).toBe("ok");
    expect(sent).toEqual([{ url: "https://public.test/x", redirect: "manual" }]);
  });

  it("checks every redirect hop again", async () => {
    const hops = recording((url) =>
      url.pathname === "/start" ? redirectTo("/next") : new Response("done"),
    );
    expect(await (await hops.fetch("https://public.test/start")).text()).toBe("done");
    expect(hops.sent.map((entry) => entry.url)).toEqual([
      "https://public.test/start",
      "https://public.test/next",
    ]);

    for (const location of ["https://private.test/x", "http://public.test/x"]) {
      const unsafe = recording((url) =>
        url.hostname === "public.test" && url.protocol === "https:"
          ? redirectTo(location)
          : new Response("leaked"),
      );
      await expect(unsafe.fetch("https://public.test/start")).rejects.toBeInstanceOf(
        UnsafeAddressError,
      );
      expect(unsafe.sent).toHaveLength(1);
    }
  });

  it("hands a redirect back when the caller follows its own, and stops a loop", async () => {
    const manual = recording(() => redirectTo("https://private.test/x"));
    const response = await manual.fetch("https://public.test/x", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(manual.sent).toHaveLength(1);

    const loop = recording(() => redirectTo("/again"));
    expect((await loop.fetch("https://public.test/x")).status).toBe(302);
    expect(loop.sent).toHaveLength(6);

    const nowhere = recording(() => new Response(null, { status: 302 }));
    expect((await nowhere.fetch("https://public.test/x")).status).toBe(302);
  });
});

describe("checkedLookup", () => {
  const lookup = (host: string, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown; family: unknown }>((done) =>
      checkedLookup(resolve)(host, { all }, (error, address, family) =>
        done({ error, address, family }),
      ),
    );

  it("answers with the checked addresses and refuses local ones at connect time", async () => {
    expect(await lookup("public.test", false)).toEqual({
      error: null,
      address: "93.184.216.34",
      family: 4,
    });
    expect((await lookup("public.test", true)).address).toEqual(answers["public.test"]);
    expect((await lookup("mixed.test", true)).error).toBeInstanceOf(UnsafeAddressError);
  });
});
