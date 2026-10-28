import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import {
  buildRunningGroups,
  summarizeRunning,
  type RunningProjectGroup,
  type RunningSummary,
} from "../components/running/running.logic";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";

/** The rail's glance. Keeps its object while counts hold, so streamed shell updates skip the rail. */
const runningSummaryAtom = Atom.make((get): RunningSummary => {
  const next = summarizeRunning(get(environmentThreadShells.threadShellsAtom));
  const previous = Option.getOrNull(get.self<RunningSummary>());
  return previous !== null &&
    previous.running === next.running &&
    previous.attention === next.attention
    ? previous
    : next;
}).pipe(Atom.withLabel("web-running-summary"));

export function useRunningSummary(): RunningSummary {
  return useAtomValue(runningSummaryAtom);
}

interface RunningPageState {
  readonly groups: ReadonlyArray<RunningProjectGroup>;
  readonly key: string;
}

/** What the page draws, so streamed thread updates that change none of it keep one snapshot. */
const runningPageAtom = Atom.make((get): RunningPageState => {
  const groups = buildRunningGroups(
    get(environmentThreadShells.threadShellsAtom),
    get(environmentProjects.projectsAtom),
  );
  const key = JSON.stringify(
    groups.map((group) => [
      group.key,
      group.title,
      group.threads.map((thread) => [thread.key, thread.title, thread.state]),
    ]),
  );
  const previous = Option.getOrNull(get.self<RunningPageState>());
  return previous !== null && previous.key === key ? previous : { groups, key };
}).pipe(Atom.withLabel("web-running-page"));

export function useRunningGroups(): ReadonlyArray<RunningProjectGroup> {
  return useAtomValue(runningPageAtom).groups;
}
