import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { renderIntegrationCallbackPage } from "../auth/mcpOAuthHtml.ts";
import { PAGE_HEADERS } from "../auth/mcpOAuthHttp.ts";
import * as IntegrationAuth from "./IntegrationAuth.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "integrations",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* IntegrationAuth.IntegrationAuth;
    return handlers.handleRaw("callback", ({ request }) =>
      Effect.gen(function* () {
        const query = request.url.indexOf("?");
        const outcome = yield* auth.completeCallback(
          new URLSearchParams(query === -1 ? "" : request.url.slice(query + 1)),
        );
        // The app's auth sheet closes on its own scheme; the code never leaves this server.
        if (outcome.returnScheme !== undefined) {
          return HttpServerResponse.redirect(
            `${outcome.returnScheme}://integrations/done?result=${outcome.connected ? "connected" : "failed"}`,
            { headers: PAGE_HEADERS },
          );
        }
        return HttpServerResponse.text(renderIntegrationCallbackPage(outcome), {
          status: outcome.connected ? 200 : 400,
          contentType: "text/html; charset=utf-8",
          headers: PAGE_HEADERS,
        });
      }),
    );
  }),
);
