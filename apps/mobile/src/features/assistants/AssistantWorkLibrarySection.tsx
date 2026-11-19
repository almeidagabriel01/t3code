import type { Assistant, EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useAssistantLibrary } from "../../state/assistants";
import { AssistantWorkUnavailable, useRefreshOnReconnect } from "./AssistantWorkUnavailable";

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files the assistant handed to other assistants or received from them, from the shared folder. */
export function AssistantWorkLibrarySection(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
}) {
  const library = useAssistantLibrary(props.environmentId, props.assistant.id);
  useRefreshOnReconnect(props.environmentId, [library]);
  const files = library.data?.files ?? [];
  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          Library
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          Files it handed to other assistants, or got from them. They live on the server.
        </Text>
      </View>
      {library.error !== null ? (
        <AssistantWorkUnavailable what="its files" onRetry={library.refresh} />
      ) : files.length === 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {library.data === null ? "Loading its files." : "No files yet."}
        </Text>
      ) : (
        <ListSection>
          {files.map((file) => (
            <View key={file.path} className="bg-grouped-card">
              <ListRowLayout
                icon="doc.text"
                label={file.name}
                description={`${
                  file.direction === "sent"
                    ? "Sent"
                    : `Received${file.from === null ? "" : ` from ${file.from}`}`
                } · ${sizeLabel(file.size)} · ${new Date(file.savedAt).toLocaleDateString()}`}
              />
            </View>
          ))}
        </ListSection>
      )}
      {library.data?.truncated ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          Showing the newest files.
        </Text>
      ) : null}
    </View>
  );
}
