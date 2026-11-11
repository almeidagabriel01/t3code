import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import type { ThreadDevicePreview } from "./threadDevicePreviews";

/** The view-only notice and each issue the user can fix, muted under the stream chrome. */
export function DeviceNotices({ preview }: { readonly preview: ThreadDevicePreview | null }) {
  if (!preview) return null;
  const issues = preview.issues.filter((issue) => !issue.blocksView);
  if (!preview.viewOnlyNotice && issues.length === 0) return null;
  return (
    <View className="gap-1 px-5 py-2" pointerEvents="none">
      {preview.viewOnlyNotice ? (
        <AppText className="text-center text-xs text-foreground-muted">
          {preview.viewOnlyNotice}
        </AppText>
      ) : null}
      {issues.map((issue) => (
        <AppText key={issue.reason} className="text-center text-xs text-foreground-muted">
          {`${issue.title}. ${issue.action}`}
        </AppText>
      ))}
    </View>
  );
}
