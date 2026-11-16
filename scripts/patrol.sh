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
echo "== dir convention =="
# 目录治理零容忍: 根级只认声明过的配置/构建/工具状态(白名单见 README 目录定义), 白名单外散落即失败;
# 构建产物入库即失败; scripts/src 出现盘符路径报告式提示(隐私守卫自身的检测模式除外)。
allow_re='^(node_modules|lib|\.claude|\.obelisk|\.npmrc|\.DS_Store|tmp)$'
stray=$(git status --ignored --porcelain | awk '$1=="!!"||$1=="??" {print $2}' | sed 's:/$::' | grep -v '/' | grep -Ev "$allow_re" || true)
if [ -n "$stray" ]; then echo "根级散落(白名单外):"; echo "$stray"; fail=1; fi
art=$(git ls-files -- 'lib/*' 'dist/*' '*.tgz' '*.tsbuildinfo')
if [ -n "$art" ]; then echo "构建产物入库:"; echo "$art"; fail=1; fi
hard=$(git grep -nE '[CD]:[/\\]' -- 'scripts/*.sh' 'src/*' | grep -v 'push-master.sh' || true)
[ -n "$hard" ] && { echo "提示: scripts/src 出现盘符路径(人工确认):"; echo "$hard"; }
exit $fail
