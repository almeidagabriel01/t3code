import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { WorkingDuration } from "./WorkingDuration";

it("repaints five running rows once a minute, not every second", async () => {
  // The clock arms its timer when the first row subscribes, so time is faked before the render.
  using _timers = fakeTimers({ now: Date.parse("2026-01-01T00:00:30.000Z") });
  let commits = 0;
  await using screen = await render(
    <Profiler id="durations" onRender={() => (commits += 1)}>
      {[0, 1, 2, 3, 4].map((index) => (
        <WorkingDuration key={index} startedAt="2026-01-01T00:00:00.000Z" />
      ))}
    </Profiler>,
    { router: false }, // A bare component; no route reads it.
  );
  const labels = () =>
    [...screen.container.querySelectorAll("span")].map((span) => span.textContent);
  expect(labels()).toEqual(["<1m", "<1m", "<1m", "<1m", "<1m"]);
  const mounted = commits;
  for (let second = 0; second < 60; second += 1) {
    await act(() => vi.advanceTimersByTime(1_000));
  }
  expect(commits - mounted).toBe(1);
  expect(labels()).toEqual(["1m", "1m", "1m", "1m", "1m"]);
});
