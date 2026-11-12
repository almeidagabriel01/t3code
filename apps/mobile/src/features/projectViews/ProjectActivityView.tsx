import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  selectProjectActivity,
  type ProjectActivityOutcome,
} from "@t3tools/client-runtime/state/thread-activity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useThreadShells } from "../../state/entities";
import { buildHomeActivityEntries } from "../home/homeActivityEntries";
import { useThreadListNow } from "../threads/use-thread-list-now";
import { ProjectViewMessage } from "./ProjectViewMessage";

const OUTCOME = {
  "needs-you": { label: "Needs you", className: "text-adaptive-amber-700-300" },
  failed: { label: "Failed", className: "text-adaptive-rose-600-400" },
  interrupted: { label: "Interrupted", className: "text-foreground-muted" },
  finished: { label: "Finished", className: "text-adaptive-emerald-600-400" },
} as const satisfies Record<ProjectActivityOutcome, { label: string; className: string }>;

/** The project's runs that wait on the user or ended unseen, newest first; a row opens its thread. */
export function ProjectActivityView(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threads = useThreadShells();
  const now = useThreadListNow(threads);
  const openDecisionThreadKeys = useOpenDecisionThreadKeys();
  const entries = selectProjectActivity(
    buildHomeActivityEntries({ threads, now, openDecisionThreadKeys }),
    props,
  );
  if (entries.length === 0) {
    return (
      <ProjectViewMessage
        title="Nothing new in this project"
        detail="Runs that finish, fail or wait on you show here until you open them."
      />
    );
  }
  return (
    <ListSection>
      {entries.map((entry) => {
        const outcome = OUTCOME[entry.outcome];
        const ref = scopeThreadRef(entry.thread.environmentId, entry.thread.id);
        return (
          <RowPressable
            key={entry.key}
            accessibilityRole="button"
            accessibilityLabel={`${entry.thread.title}, ${outcome.label}`}
            onPress={() => props.onOpenThread(ref.threadId)}
            className="bg-grouped-card"
          >
            <ListRowLayout
              label={entry.thread.title}
              meta={
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  <Text className={cn("text-xs font-t3-medium", outcome.className)}>
                    {outcome.label}
                  </Text>
                  {entry.at === null ? null : (
                    <>
                      {" · "}
                      <RelativeTime timestamp={entry.at} />
                    </>
                  )}
                </Text>
              }
            />
          </RowPressable>
        );
      })}
    </ListSection>
  );
}
