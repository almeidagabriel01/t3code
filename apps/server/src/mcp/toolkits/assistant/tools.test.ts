import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { AssistantParameters } from "./tools.ts";

const decodeParameters = Schema.decodeUnknownSync(AssistantParameters);

it.each([
  ["a model within the limit", "claude-opus-5-5", true],
  ["a model over the limit", "x".repeat(257), false],
])("group_post takes %s", (_name, model, decodes) => {
  const input: unknown = {
    action: "group_post",
    group: "Dev",
    text: "look",
    model: { providerInstanceId: "claudeAgent", model },
  };
  const decode = () => decodeParameters(input);
  if (decodes) expect(decode().model?.model).toBe(model);
  else expect(decode).toThrow();
});
