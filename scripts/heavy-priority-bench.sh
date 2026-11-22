#!/bin/bash
# Times one suite under each CPU priority T3 can give a job on macOS, ROUNDS times each in
# rotating order, and prints the median of each against normal. normal runs twice per round
# (normal, normal2): their gap is the noise floor any other difference has to beat.
#
#   normal      default priority
#   background  `taskpolicy -b`: background QoS, E-cores only on Apple Silicon, I/O throttled
#   utility     `taskpolicy -c utility` (only settable at launch)
#   nice        `nice -n 10` (an unprivileged user cannot renice a running job back to 0)
#   tier        `taskpolicy -t 5 -l 5`: lowest throughput and latency tiers, settable both ways
#
# STRESS=N starts N `yes` loops for the whole run to put the Mac over its ceiling the way other
# work does; they are killed by the PIDs captured here.
#
#   scripts/heavy-priority-bench.sh                 # packages/shared's Vitest suite, 3 rounds
#   STRESS=10 VARIANTS="normal normal2 background nice tier" scripts/heavy-priority-bench.sh
#   ROUNDS=5 scripts/heavy-priority-bench.sh -- vp test run --dir src   # any command, from $PWD
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
rounds=${ROUNDS:-3}
read -r -a variants <<<"${VARIANTS:-normal normal2 background utility}"
if [ "${1:-}" = "--" ]; then
  shift
  dir=$PWD
  suite=("$@")
else
  dir=$root/packages/shared
  suite=(vp test run --config ../../vite.config.ts --dir .)
fi
[ "$(uname)" = Darwin ] || { echo "taskpolicy is macOS only" >&2; exit 1; }

log=$(mktemp -t heavy-priority-bench)
stress=()
cleanup() {
  [ ${#stress[@]} -eq 0 ] || kill "${stress[@]}" 2>/dev/null || true
  rm -f "$log" "${times:-}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
for ((i = 0; i < ${STRESS:-0}; i++)); do
  yes >/dev/null &
  stress+=($!)
done

load() { sysctl -n vm.loadavg | awk '{print $2}'; }
echo "suite: ${suite[*]}  (in $dir)"
echo "rounds: $rounds  stress: ${STRESS:-0}  load average now: $(load)  cores: $(sysctl -n hw.ncpu)"

times=$(mktemp -t heavy-priority-bench-cpu)
run() {
  local timed=(/usr/bin/time -p -o "$times")
  case $1 in
    normal | normal2) "${timed[@]}" "${suite[@]}" ;;
    background) "${timed[@]}" /usr/sbin/taskpolicy -b "${suite[@]}" ;;
    utility) "${timed[@]}" /usr/sbin/taskpolicy -c utility "${suite[@]}" ;;
    nice) "${timed[@]}" nice -n 10 "${suite[@]}" ;;
    tier) "${timed[@]}" /usr/sbin/taskpolicy -t 5 -l 5 "${suite[@]}" ;;
    *) echo "unknown variant $1" >&2; return 2 ;;
  esac
}

# A suite that fails at once would time nothing: run it once (also warming caches) and stop if so.
(cd "$dir" && "${suite[@]}") >/dev/null 2>&1 || { echo "the suite fails on its own; fix it first" >&2; exit 1; }

count=${#variants[@]}
for ((round = 0; round < rounds; round++)); do
  for ((i = 0; i < count; i++)); do
    # Rotate the order each round so warm caches and drift do not favour one variant.
    variant=${variants[$(((i + round) % count))]}
    start=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
    if (cd "$dir" && run "$variant") >/dev/null 2>&1; then status=ok; else status=failed; fi
    end=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
    seconds=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }')
    # CPU seconds barely move with outside load, but grow when the job lands on slower cores.
    cpu=$(awk '$1 == "user" || $1 == "sys" { t += $2 } END { printf "%.1f", t }' "$times")
    echo "$variant $seconds $status $round $cpu" >>"$log"
    echo "round $((round + 1)) $variant: ${seconds}s, ${cpu} cpu-s ($status, load $(load))"
  done
done

echo
# Each run against the mean of normal and normal2 in its own round, so load drift cancels;
# normal2's own ratio is the noise floor a difference has to clear.
printf '%-11s %12s %14s %12s\n' variant median_wall median_vs_norm median_cpu
for variant in "${variants[@]}"; do
  awk -v v="$variant" '
    $3 == "ok" { wall[$1, $4] = $2; cpu[$1, $4] = $5; rounds[$4] = 1 }
    function median(a, n,   i, j, t) {
      for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (a[j] < a[i]) { t = a[i]; a[i] = a[j]; a[j] = t }
      return (n % 2) ? a[(n + 1) / 2] : (a[n / 2] + a[n / 2 + 1]) / 2
    }
    END {
      for (r in rounds) if ((v, r) in wall && ("normal", r) in wall && ("normal2", r) in wall) {
        n++; w[n] = wall[v, r]; c[n] = cpu[v, r]
        q[n] = wall[v, r] / ((wall["normal", r] + wall["normal2", r]) / 2)
      }
      if (n == 0) { printf "%-11s %12s\n", v, "no runs"; exit }
      printf "%-11s %11.1fs %+13.1f%% %11.1fs\n", v, median(w, n), (median(q, n) - 1) * 100, median(c, n)
    }' "$log"
done
if grep -q " failed " "$log"; then echo "some runs failed: check the suite on its own first" >&2; fi
