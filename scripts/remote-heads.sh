#!/usr/bin/env bash
# 用途: 数各可写远端 refs/heads 总数并对照 AGENTS.md v1.15 的 ≤10 预算; 只读不 fetch。
# 用法: bash scripts/remote-heads.sh [remote ...]   # 缺省 origin github; 超额退出码 1
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
remotes=("$@")
[ ${#remotes[@]} -gt 0 ] || remotes=(origin github)
fail=0
for r in "${remotes[@]}"; do
  n=$(git ls-remote --heads "$r" | wc -l | tr -d ' ')
  verdict=OK
  [ "$n" -gt 10 ] && { verdict=OVER-BUDGET; fail=1; }
  echo "[$r] heads=$n/10 $verdict"
  git ls-remote --heads "$r" | awk -v r="$r" '{print "  " r " " $2 " " substr($1,1,9)}'
done
exit $fail
