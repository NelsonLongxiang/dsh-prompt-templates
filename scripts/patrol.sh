#!/usr/bin/env bash
# 用途: 例行运维巡检一站式入口——分支审计 + ≤10 预算 + 在途 PR + master CI + 工作树漂移; 全程只读。
#       预算超额或 gh 查询失败退出码 1; 工作树漂移只展示不判失败(他人现场由人裁决)。
# 用法: bash scripts/patrol.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
echo "== branch audit =="
bash scripts/branch-audit.sh || fail=1
echo "== head budget =="
bash scripts/remote-heads.sh || fail=1
echo "== open PRs =="
gh pr list --repo NelsonLongXiang/dsh-prompt-templates || fail=1
echo "== master CI (latest) =="
gh run list --repo NelsonLongXiang/dsh-prompt-templates --branch master --limit 1 || fail=1
echo "== working tree =="
git status --short --branch | head -3
exit $fail
