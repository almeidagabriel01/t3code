import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as IntegrationAuth from "./IntegrationAuth.ts";
import * as IntegrationsHttp from "./integrationsHttp.ts";

class IntegrationsTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.integrations,
) {}

const request = (outcome: IntegrationAuth.IntegrationCallbackOutcome, query: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const seen: Array<string> = [];
      const routes = HttpApiBuilder.layer(IntegrationsTestApi).pipe(
        Layer.provide(IntegrationsHttp.layer),
        Layer.provide(
          Layer.mock(IntegrationAuth.IntegrationAuth)({
            catalog: [],
            completeCallback: (params) =>
              Effect.sync(() => {
                seen.push(params.toString());
                return outcome;
              }),
          }),
        ),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
      );
      return { seen, web: HttpRouter.toWebHandler(routes, { disableLogger: true }) };
    }),
    ({ seen, web }) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://127.0.0.1/oauth/integrations/callback${query}`, {
            redirect: "manual",
          }),
          Context.empty(),
        );
        return {
          seen,
          status: response.status,
          location: response.headers.get("location"),
          cache: response.headers.get("cache-control"),
          body: await response.text(),
        };
      }),
    ({ web }) => Effect.promise(() => web.dispose()),
  );

it.effect("passes the query to the service and shows the outcome without the code", () =>
  Effect.gen(function* () {
    const connected = yield* request(
      { connected: true, serviceName: "<Linear>", returnScheme: undefined },
      "?code=secret-code&state=s1",
    );
    expect(connected.seen).toEqual(["code=secret-code&state=s1"]);
    expect(connected.status).toBe(200);
    expect(connected.cache).toBe("no-store");
    expect(connected.body).toContain("Connected to &lt;Linear&gt;");
    expect(connected.body).not.toContain("secret-code");

    const failed = yield* request(
      { connected: false, serviceName: undefined, returnScheme: undefined },
      "",
    );
    expect(failed.seen).toEqual([""]);
    expect(failed.status).toBe(400);
    expect(failed.body).toContain("Sign-in expired");
  }),
);

it.effect("sends the app back to its own scheme with the result only", () =>
  Effect.gen(function* () {
    for (const connected of [true, false]) {
      const response = yield* request(
        { connected, serviceName: "Linear", returnScheme: "t3code-dev" },
        "?code=secret-code&state=s1",
      );
      expect(response.status).toBe(302);
      expect(response.location).toBe(
        `t3code-dev://integrations/done?result=${connected ? "connected" : "failed"}`,
      );
    }
  }),
);
