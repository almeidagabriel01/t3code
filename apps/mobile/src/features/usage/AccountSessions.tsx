import {
  groupSessionsByProject,
  splitSessions,
  type UsageSession,
} from "@t3tools/client-runtime/state/usageSessions";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

function SessionGroups(props: {
  readonly sessions: ReadonlyArray<UsageSession>;
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly onOpen: (session: UsageSession) => void;
}) {
  return groupSessionsByProject(props.sessions).map((group) => (
    <View key={group.projectKey} className="gap-1">
      <Text className="text-xs font-t3-medium text-foreground-muted">
        {props.projectTitles.get(group.projectKey) ?? "Project"}
      </Text>
      {group.sessions.map((session) => (
        <Pressable
          key={`${session.environmentId}:${session.threadId}`}
          accessibilityRole="button"
          onPress={() => props.onOpen(session)}
          className="min-h-9 flex-row items-center gap-2 active:opacity-70"
        >
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {session.title}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {session.state === "waiting" ? "Waiting" : session.state === "working" ? "Working" : ""}{" "}
            {session.elapsed}
          </Text>
        </Pressable>
      ))}
    </View>
  ));
}

/** "Sessions · 2 running", with finished threads in their own collapsed list. */
export function AccountSessions(props: {
  readonly sessions: ReadonlyArray<UsageSession>;
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly onOpen: (session: UsageSession) => void;
}) {
  const [finishedOpen, setFinishedOpen] = useState(false);
  if (props.sessions.length === 0) return null;
  const { running, finished } = splitSessions(props.sessions);
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
      <Text className="text-sm font-t3-medium text-foreground">
        {running.length > 0 ? `Sessions · ${running.length} running` : "Sessions"}
      </Text>
      <SessionGroups sessions={running} projectTitles={props.projectTitles} onOpen={props.onOpen} />
      {finished.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: finishedOpen }}
            onPress={() => setFinishedOpen((value) => !value)}
            className="min-h-9 justify-center active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-foreground-muted">
              {`Finished · ${finished.length}`}
            </Text>
          </Pressable>
          {finishedOpen ? (
            <SessionGroups
              sessions={finished}
              projectTitles={props.projectTitles}
              onOpen={props.onOpen}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}
