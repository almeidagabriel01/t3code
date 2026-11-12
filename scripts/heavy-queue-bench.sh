#!/bin/bash
# Three agents testing at once, without and with the heavy queue: starts the same suite three
# times concurrently per mode and prints wall time, peak swap, sys% and memory-pressure samples.
# Run it on a free Mac. The queue mode uses this checkout's own queue, never ~/.t3/heavy-queue.
#
#   scripts/heavy-queue-bench.sh                  # packages/shared's Vitest suite, both modes
#   MODES=queue scripts/heavy-queue-bench.sh -- vp test run --dir src   # any command, from $PWD
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
queue_dir=${T3CODE_HEAVY_QUEUE_DIR:-$root/.t3/heavy-queue-dev}
read -r -a modes <<<"${MODES:-direct queue}"
if [ "${1:-}" = "--" ]; then
  shift
  dir=$PWD
  suite=("$@")
else
  dir=$root/packages/shared
  suite=(vp test run --config ../../vite.config.ts --dir .)
fi
[ "$(uname)" = Darwin ] || { echo "the samplers are macOS only" >&2; exit 1; }

load=$(sysctl -n vm.loadavg | awk '{print $2}')
echo "suite: ${suite[*]}  (in $dir)"
echo "modes: ${modes[*]}  queue: $queue_dir  load average now: $load"
awk -v l="$load" 'BEGIN { exit !(l > 2) }' &&
  echo "warning: the machine is not free (load > 2); the result will not hold" >&2

out=$(mktemp -d -t heavy-queue-bench)
echo "logs: $out"
sampler=
trap '[ -n "$sampler" ] && kill "$sampler" 2>/dev/null; true' EXIT
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time'; }

run() {
  if [ "$1" = queue ]; then
    node "$root/apps/server/src/bin.ts" heavy --queue-dir "$queue_dir" --name "bench $2" -- "${suite[@]}"
  else
    "${suite[@]}"
  fi
}

for mode in "${modes[@]}"; do
  echo "running ${mode}..."
  samples=$out/$mode.samples
  : >"$samples"
  # `top -l 2` reports sys% over the 5 s between its two samples, so each line covers 5 s.
  (while true; do
    swap=$(sysctl -n vm.swapusage | awk '{gsub("M", "", $6); print $6}')
    level=$(sysctl -n kern.memorystatus_vm_pressure_level)
    sys=$(top -l 2 -s 5 -n 0 | awk '/CPU usage/ { v = $5 } END { gsub("%", "", v); print v }')
    echo "$swap $level $sys" >>"$samples"
  done) &
  sampler=$!
  start=$(now)
  pids=()
  for i in 1 2 3; do
    (s=$(now); cd "$dir" && if run "$mode" "$i" >"$out/$mode.run$i.log" 2>&1; then rc=0; else rc=$?; fi
      echo "$rc $(awk -v a="$s" -v b="$(now)" 'BEGIN { printf "%.0f", b - a }')" >"$out/$mode.run$i.result") &
    pids+=($!)
  done
  wait "${pids[@]}"
  total=$(awk -v a="$start" -v b="$(now)" 'BEGIN { printf "%.0f", b - a }')
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  sampler=
  echo "$total" >"$out/$mode.total"
done

echo
printf '%-7s %7s %-16s %6s %13s %13s %10s\n' mode total runs failed peak_swap_GB sys%_mean/max pressure≥2
for mode in "${modes[@]}"; do
  runs=$(cat "$out/$mode".run*.result | awk '{printf "%s%ss", sep, $2; sep="/"}')
  failed=$(cat "$out/$mode".run*.result | awk '$1 != 0 { n++ } END { print n + 0 }')
  awk -v mode="$mode" -v total="$(cat "$out/$mode.total")" -v runs="$runs" -v failed="$failed" '
    { if ($1 > swap) swap = $1; sys += $3; if ($3 > peak) peak = $3; if ($2 >= 2) high++; n++ }
    END { printf "%-7s %6ss %-16s %6s %13.2f %6.1f/%-6.1f %4d of %-3d\n",
      mode, total, runs, failed, swap / 1024, n ? sys / n : 0, peak, high, n }' "$out/$mode.samples"
done
awk '$1 != 0 { failed = 1 } END { exit failed }' "$out"/*.run*.result ||
  echo "some runs failed: read $out/<mode>.run<n>.log" >&2
