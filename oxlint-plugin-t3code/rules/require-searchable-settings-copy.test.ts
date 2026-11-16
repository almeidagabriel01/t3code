import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-searchable-settings-copy", {
  filename: "apps/web/src/components/settings/Example.tsx",
});

describe("t3code/require-searchable-settings-copy", () => {
  rule.valid(
    "allows text read from the search index",
    `const row = <SettingsRow {...searchableSetting("theme")} control={<Switch aria-label="Theme" />} />;`,
  );

  rule.valid(
    "allows a repeated row's copy around a dynamic suffix",
    `const section = <SettingsSection title={\`\${settingCopy("sandbox").title}\${suffix}\`} />;`,
  );

  rule.valid(
    "allows data and punctuation",
    `const row = <SettingsRow title={server.name} description={<span>{server.transport} · {server.url}</span>} />;`,
  );

  rule.invalid("reports a string title", `const row = <SettingsRow title="Period" />;`);

  rule.invalid(
    "reports a description that overrides the index",
    `const row = <SettingsRow {...searchableSetting("theme")} description="Choose how it looks." />;`,
  );

  rule.invalid(
    "reports text inside a JSX title",
    `const row = <SettingsRow title={<span className="flex"><Icon />Sandbox container</span>} />;`,
  );

  rule.invalid(
    "reports text in either branch of a conditional",
    `const row = <SettingsRow title="x" description={ready ? detail : "Loading the sandbox."} />;`,
  );

  rule.invalid(
    "reports a section title template",
    `const section = <SettingsSection title={\`Autonomy\${suffix}\`} />;`,
  );
});
