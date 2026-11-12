#!/bin/bash
# Times one test suite at normal CPU priority, under `taskpolicy -b` and under
# `taskpolicy -c utility`, ROUNDS times each in rotating order, and prints the median of each
# against normal. Run it on a free Mac: the answer decides AGENT_JOB_CPU in
# apps/server/src/heavyQueue/heavyCli.ts (background only when within ~15% of normal).
#
#   scripts/heavy-priority-bench.sh                 # packages/shared's Vitest suite, 3 rounds
#   ROUNDS=5 scripts/heavy-priority-bench.sh -- vp test run --dir src   # any command, from $PWD
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
rounds=${ROUNDS:-3}
if [ "${1:-}" = "--" ]; then
  shift
  dir=$PWD
  suite=("$@")
else
  dir=$root/packages/shared
  suite=(vp test run --config ../../vite.config.ts --dir .)
fi
[ "$(uname)" = Darwin ] || { echo "taskpolicy is macOS only" >&2; exit 1; }

load=$(sysctl -n vm.loadavg | awk '{print $2}')
echo "suite: ${suite[*]}  (in $dir)"
echo "rounds: $rounds  load average now: $load  cores: $(sysctl -n hw.ncpu)"
awk -v l="$load" 'BEGIN { exit !(l > 2) }' &&
  echo "warning: the machine is not free (load > 2); the result will not hold" >&2

log=$(mktemp -t heavy-priority-bench)
trap 'rm -f "$log"' EXIT
variants=(normal background utility)
run() {
  case $1 in
    normal) "${suite[@]}" ;;
    background) /usr/sbin/taskpolicy -b "${suite[@]}" ;;
    utility) /usr/sbin/taskpolicy -c utility "${suite[@]}" ;;
  esac
}

for ((round = 0; round < rounds; round++)); do
  for ((i = 0; i < 3; i++)); do
    # Rotate the order each round so warm caches and drift do not favour one variant.
    variant=${variants[$(((i + round) % 3))]}
    start=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
    if (cd "$dir" && run "$variant") >/dev/null 2>&1; then status=ok; else status=failed; fi
    end=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
    seconds=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }')
    echo "$variant $seconds $status" >>"$log"
    echo "round $((round + 1)) $variant: ${seconds}s ($status)"
  done
done

echo
printf '%-11s %-24s %8s %9s\n' variant runs median vs_normal
median() { grep "^$1 " "$log" | awk '{print $2}' | sort -n | awk '{a[NR]=$1} END {print (NR % 2) ? a[(NR + 1) / 2] : (a[NR / 2] + a[NR / 2 + 1]) / 2}'; }
base=$(median normal)
for variant in "${variants[@]}"; do
  m=$(median "$variant")
  printf '%-11s %-24s %7.1fs %+8.1f%%\n' "$variant" \
    "$(grep "^$variant " "$log" | awk '{printf "%s%s", sep, $2; sep=","}')" \
    "$m" "$(awk -v m="$m" -v b="$base" 'BEGIN { print (m / b - 1) * 100 }')"
done
if grep -q " failed$" "$log"; then echo "some runs failed: check the suite on its own first" >&2; fi
bg=$(median background)
awk -v m="$bg" -v b="$base" 'BEGIN { exit !(m <= b * 1.15) }' &&
  echo "verdict: background is within 15%; set AGENT_JOB_CPU = \"background\"" ||
  echo "verdict: background is more than 15% slower; keep AGENT_JOB_CPU = \"normal\""
