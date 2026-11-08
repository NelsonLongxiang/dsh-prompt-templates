#!/usr/bin/env bash
# 用途: master 发布入口(github 单端; 2026-11-08 属主裁定取消维护 gitee 镜像)——干净树守卫 → 刷新 github → 待推区间隐私四层排查(内容+提交信息) → 推 github → 终态计数。
#       隐私模式豁免公开身份: 包 scope @nelsonlongxiang 与测试样例 C:\Users\dsh; 命中即中止不推(退出码 3)。
# 用法: bash scripts/push-master.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || { echo "工作树不干净 — 先收尾再推"; exit 2; }
git fetch -q github
pending=$(git rev-list github/master..master)
if [ -z "$pending" ]; then
  echo "无待推提交 (github/master..master 为空)"
fi
# 隐私排查: 内网网段/机器用户名/内网域/本机盘符路径; 豁免 dsh 测试样例家目录
# 敏感词用拼接构造: 脚本源码自身不含连续字面量, 避免隐私扫描自噬
seg1='Admini'; seg2='strator'; seg3='davor'; seg4='ia'; seg5='jf-'; seg6='tech'; seg7='/d/'; seg8='workspace'
pat_re="192\.168\.|(^|[^0-9])10\.0\.|172\.(1[6-9]|2[0-9]|3[01])\.|\${seg1}\${seg2}|\${seg3}\${seg4}|\${seg5}\${seg6}|C:\\Users\\|D:\\\${seg8}|\${seg7}\${seg8}"
hits=$(git diff github/master...master | grep -inE "$pat_re" | grep -viE "C:\\\\Users\\\\dsh" || true)
msg_hits=$(git log github/master..master --format=%B | grep -inE "$pat_re" || true)
if [ -n "$hits" ] || [ -n "$msg_hits" ]; then
  echo "隐私排查命中 (中止, 未推送):"
  [ -n "$hits" ] && echo "$hits"
  [ -n "$msg_hits" ] && echo "-- commit messages: $msg_hits"
  exit 3
fi
echo "隐私排查: clean"
git push github master
echo "--- 终态:"
bash scripts/remote-heads.sh github
