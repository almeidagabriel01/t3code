import {
  BASE_FONT_SIZE_STEP,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { SettingsSection } from "../../components/SettingsSection";
import { APPEARANCE_COPY } from "../appearanceCopy";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  TextAppearancePreview,
} from "../components/AppearancePreviews";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function TextAppearanceSection() {
  const { isReady, appearance, setBaseFontSize, mathRenderingEnabled, setMathRenderingEnabled } =
    useAppearancePreferences();

  return (
    <SettingsSection title={APPEARANCE_COPY.text.title}>
      <TextAppearancePreview fontSize={appearance.baseFontSize} />
      <AppearancePreviewSeparator />
      <FontSizeSliderRow
        disabled={!isReady}
        icon="textformat.size"
        label={APPEARANCE_COPY.text.textSize}
        max={MAX_BASE_FONT_SIZE}
        min={MIN_BASE_FONT_SIZE}
        onChange={setBaseFontSize}
        step={BASE_FONT_SIZE_STEP}
        value={appearance.baseFontSize}
        valueLabel={`${appearance.baseFontSize} pt`}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="plusminus"
        label={APPEARANCE_COPY.text.renderMath}
        value={mathRenderingEnabled}
        onValueChange={setMathRenderingEnabled}
      />
    </SettingsSection>
  );
}
