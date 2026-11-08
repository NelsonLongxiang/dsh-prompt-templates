#!/usr/bin/env bash
# 用途: fetch 后分类远端所有非 master 分支——①已并入/补丁等价(记 SHA 可删可恢复) vs ③带独有提交(留属主裁决); 只读, 不删任何分支。
#       2026-11-08 属主裁定取消维护 gitee: 缺省只审 github, origin 已冻结。
# 用法: bash scripts/branch-audit.sh [remote ...]   # 缺省 github
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
remotes=("$@")
[ ${#remotes[@]} -gt 0 ] || remotes=(github)
for r in "${remotes[@]}"; do git fetch -q "$r"; done
master=$(git rev-parse master)
for r in "${remotes[@]}"; do
  echo "== $r =="
  git ls-remote --heads "$r" | while read -r sha ref; do
    name=${ref#refs/heads/}
    [ "$name" = master ] && continue
    if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
      echo "  $name  SHA-UNKNOWN(locally) $sha"
      continue
    fi
    if git merge-base --is-ancestor "$sha" "$master"; then
      echo "  $name  CAT1-MERGED 可删 | 恢复: git push $r $sha:refs/heads/$name"
    elif [ -z "$(git cherry "$master" "$sha" | grep -v '^-')" ]; then
      echo "  $name  CAT1-ABSORBED 补丁等价可删 | 恢复: git push $r $sha:refs/heads/$name"
    else
      echo "  $name  CAT3-UNIQUE $(git rev-list --count "$master..$sha") 独有提交 留属主"
    fi
  done
done
