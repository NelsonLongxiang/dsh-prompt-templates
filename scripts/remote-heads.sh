#!/usr/bin/env bash
# 用途: 数远端 refs/heads 总数并对照 ≤10 预算; 只读不 fetch。
#       2026-11-08 属主裁定取消维护 gitee: 单一可写端 github, origin 保留只读访问。
# 用法: bash scripts/remote-heads.sh [remote ...]   # 缺省 github; 超额退出码 1
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
remotes=("$@")
[ ${#remotes[@]} -gt 0 ] || remotes=(github)
fail=0
for r in "${remotes[@]}"; do
  n=$(git ls-remote --heads "$r" | wc -l | tr -d ' ')
  verdict=OK
  [ "$n" -gt 10 ] && { verdict=OVER-BUDGET; fail=1; }
  echo "[$r] heads=$n/10 $verdict"
  git ls-remote --heads "$r" | awk -v r="$r" '{print "  " r " " $2 " " substr($1,1,9)}'
done
exit $fail
