import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { TextField } from "./AssistantFormFields";
import { useStartDescribeAssistant } from "./describeAssistant";

/** The user describes an assistant or group; a Scratch thread opens with that request ready to send. */
export function DescribeAssistantRouteScreen() {
  const insets = useSafeAreaInsets();
  const start = useStartDescribeAssistant();
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = description.trim() !== "" && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const failure = await start(description);
    setBusy(false);
    if (failure === null) setDescription("");
    else setError(failure);
  };

  return (
    <SettingsScreen title="Describe an assistant">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <TextField
          label="What should it do?"
          description="Say what you want in your own words. T3 opens a thread that builds it with you."
          value={description}
          multiline
          autoCapitalize="sentences"
          placeholder="A reviewer for my web project that checks every pull request, or a Finance group with a CFO and an analyst"
          onChange={setDescription}
        />
        {error ? (
          <Text
            accessibilityRole="alert"
            textRole="footnote"
            className="px-2 text-danger-foreground"
          >
            {error}
          </Text>
        ) : null}
        <Button
          label="Start"
          tone="primary"
          fullWidth
          loading={busy}
          disabled={!canSubmit}
          onPress={() => void submit()}
        />
      </ScrollView>
    </SettingsScreen>
  );
}
