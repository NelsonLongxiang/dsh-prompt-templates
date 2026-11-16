#!/usr/bin/env bash
# 用途: 发布机械链——人工前置(bump 版本号 + docs/release-notes-<ver>.md 定稿)完成后执行:
#       verify → 发布提交 → 私仓发布 → npm pack 拉回直验(锚定版本字段) → 公网发布 → npmjs GET 200 确认
#       → push master → tag v<ver> → GitHub Release → 双 registry 终态。
#       任一断言失败即停; 公网发布被接受后绝不重发(重复版本会被 npm 拒绝)。
#       断点恢复: 工作树只允许本版 bump+notes 未收尾改动; 未推提交只允许本版 release 提交;
#       已存在的本版 release 提交/tag/GitHub Release 跳过重做; npm 已接受的版本由 npm 拒绝并停下。
#       DRYRUN=1 只走守卫与 verify 并打印将执行的链, 不做任何实效动作。
# 用法: bash scripts/release.sh "<本版一句话主题>"
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ver=$(node -p "require('./package.json').version")
subject="${1:-release}"
dry=${DRYRUN:-0}

echo "== guard =="
dirty=$(git status --porcelain)
if [ -n "$dirty" ]; then
  foreign_paths=$(printf '%s\n' "$dirty" | cut -c4- | grep -vxF -e package.json -e "docs/release-notes-${ver}.md" || true)
  if [ -n "$foreign_paths" ]; then
    echo "工作树不干净——只允许本版 bump+notes 改动, 其他先收尾:"
    echo "$foreign_paths"
    exit 2
  fi
fi
git fetch -q github
unpushed=$(git rev-list github/master..master)
if [ -n "$unpushed" ]; then
  foreign_subjects=$(git log --format=%s github/master..master | grep -vF "chore(release): ${ver}" || true)
  if [ -n "$foreign_subjects" ]; then
    echo "存在待推提交(不止本版 release 提交)——先 bash scripts/push-master.sh"
    exit 2
  fi
  echo "未推提交仅含本版 release 提交——断点恢复流程"
fi
[ -f "docs/release-notes-${ver}.md" ] || { echo "缺 docs/release-notes-${ver}.md(人工定稿前置)"; exit 2; }
echo "version=${ver} subject=${subject} dry=${dry}"

echo "== verify =="
pnpm verify

if [ "$dry" = "1" ]; then
  echo "DRYRUN: 将执行——release commit → 私仓 publish → pack 直验 → 公网 publish → GET 200 → push-master → tag v${ver} → gh release"
  exit 0
fi

echo "== release commit =="
if git log -1 --format=%s | grep -qF "chore(release): ${ver}"; then
  [ -z "$(git status --porcelain)" ] || { echo "HEAD 已是本版 release 提交但工作树仍有改动——人工分辨"; exit 2; }
  echo "本版 release 提交已存在(HEAD)——跳过提交"
else
  git add "package.json" "docs/release-notes-${ver}.md"
  git commit -m "chore(release): ${ver} — ${subject}" --quiet
fi

echo "== private publish =="
npm publish

echo "== tarball pull-back verify =="
d=$(mktemp -d)
f=$(cd "$d" && npm pack "@nelsonlongxiang/dsh-prompt-templates@${ver}" --silent)
files=$(tar -tzf "$d/$f" | wc -l)
field=$(tar -xzOf "$d/$f" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
[ "$field" = "$ver" ] || { echo "直验版本字段不符: $field != $ver"; rm -rf "$d"; exit 3; }
tar -tzf "$d/$f" | grep -q 'lib/client.js$' || { echo "直验缺 lib/client.js"; rm -rf "$d"; exit 3; }
tar -tzf "$d/$f" | grep -q 'lib/cli/main.js$' || { echo "直验缺 lib/cli/main.js"; rm -rf "$d"; exit 3; }
echo "tarball ok: files=$files version=$field"
rm -rf "$d"

echo "== public publish (accepted = never retry) =="
npm publish "--@nelsonlongxiang:registry=https://registry.npmjs.org" --access public

echo "== npmjs propagation =="
ok=0
for i in 1 2 3 4 5 6; do
  sleep 55
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/@nelsonlongxiang%2Fdsh-prompt-templates/${ver}")
  echo "GET attempt $i: $code"
  if [ "$code" = "200" ]; then ok=1; break; fi
  [ "$code" = "404" ] || { echo "非预期状态码 $code——人工介入"; exit 4; }
done
[ "$ok" = "1" ] || { echo "传播超 ~6 分钟未确认——发布已被接受, 人工复核 GET"; exit 4; }

echo "== push + tag + release =="
bash scripts/push-master.sh
if git rev-parse -q --verify "refs/tags/v${ver}" >/dev/null; then
  echo "tag v${ver} 已存在——跳过打 tag"
else
  git tag "v${ver}"
fi
git push github "v${ver}"
if gh release view "v${ver}" --repo NelsonLongXiang/dsh-prompt-templates >/dev/null 2>&1; then
  echo "GitHub Release v${ver} 已存在——跳过创建"
else
  gh release create "v${ver}" --repo NelsonLongXiang/dsh-prompt-templates --title "v${ver}" --notes-file "docs/release-notes-${ver}.md"
fi

echo "== final =="
echo "private latest: $(npm view @nelsonlongxiang/dsh-prompt-templates version 2>/dev/null)"
echo "npmjs   latest: $(npm view @nelsonlongxiang/dsh-prompt-templates version '--@nelsonlongxiang:registry=https://registry.npmjs.org' 2>/dev/null)"
