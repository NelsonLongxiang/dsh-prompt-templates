#!/usr/bin/env bash
# 用途/用法: master 上准备仅版本 bump + 本版说明后运行 bash scripts/release.sh "<主题>"。
# 身份/标签预检 → verify → 再核对 → release commit → 私仓 → 项目 tmp 拉回直验 → 公网 → push/tag/release。
# DRYRUN=1 只做只读身份预检与 verify，不提交/发布/打 tag/push；verify 仍会生成正常构建产物。
# 已接受或结果未知的 publish 禁止原样重试；本脚本不自动重试，也不是任意阶段的通用恢复器。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
subject="${1:-release}"
# Opt-in requires a complete pinned identity; never infer it from a merge title.
identity_args=()
if [ "$#" -gt 1 ]; then
  [ "$#" = 3 ] && [ "$2" = --merged-prepared ] && [ -n "$3" ] || { echo 'usage: release.sh "subject" [--merged-prepared identity.json]' >&2; exit 2; }
  identity_args=("$3")
fi
dry="${DRYRUN:-0}"
guard() { node scripts/release-guard.mjs "$@"; }
guard master
[ "$dry" = 0 ] || [ "$dry" = 1 ] || { echo "DRYRUN must be 0 or 1" >&2; exit 2; }

echo "== release identity + tag preflight =="
# bash 3.2 + nounset rejects an empty array even after identity_args=().
# The conditional expansion emits zero args when empty, preserving quoted identity paths.
plan=$(guard inspect "$subject" ${identity_args[@]+"${identity_args[@]}"})
ver=$(guard field "$plan" version)
notes=$(guard field "$plan" notes)
mode=$(guard field "$plan" mode)
echo "version=$ver mode=$mode dry=$dry"

echo "== verify =="
pnpm verify
# Never commit/publish inputs or a HEAD different from the one just verified.
guard assert "$plan"
if [ "$dry" = 1 ]; then
  echo "DRYRUN: verified exact identity; no commit/publish/tag/push"
  exit 0
fi

# Allocate only ignored project-owned scratch. The helper validates every
# parent and marker before removal; it never follows a changed junction.
d=''
finish() {
  status=$?
  trap - EXIT
  if [ -n "$d" ]; then
    if ! guard scratch-remove "$d"; then
      echo "release scratch preserved: ownership/path changed; inspect manually" >&2
      [ "$status" -ne 0 ] || status=2
    fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
d=$(guard scratch-create)

echo "== release commit =="
if [ "$mode" = new ]; then
  git add -- package.json "$notes"
  git diff --cached --stat
  guard staged "$plan"
  # --only keeps an unrelated path staged concurrently after the guard out
  # of our commit; the next identity check stops before publish if it appears.
  git commit --only -m "chore(release): ${ver} — ${subject}" --quiet -- package.json "$notes"
fi
plan=$(guard finalize "$plan")
release_head=$(guard field "$plan" head)

echo "== private publish (accepted/unknown = stop, never retry) =="
guard assert "$plan"
npm publish

echo "== tarball pull-back verify =="
f=$(cd "$d" && npm pack "@nelsonlongxiang/dsh-prompt-templates@${ver}" --silent)
[[ "$f" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*[.]tgz$ ]] || { echo "unsafe/ambiguous pack filename" >&2; exit 3; }
[ -f "$d/$f" ] && [ ! -L "$d/$f" ] || { echo "packed archive missing or linked" >&2; exit 3; }
listing=$(tar -tzf "$d/$f")
field=$(tar -xzOf "$d/$f" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
[ "$field" = "$ver" ] || { echo "tarball version differs: $field != $ver" >&2; exit 3; }
printf '%s\n' "$listing" | grep -Fxq 'package/lib/client.js' || { echo "tarball lacks client bundle" >&2; exit 3; }
printf '%s\n' "$listing" | grep -Fxq 'package/lib/cli/main.js' || { echo "tarball lacks CLI" >&2; exit 3; }
echo "tarball verified: version=$field"

echo "== public publish (accepted/unknown = stop, never retry) =="
guard assert "$plan"
npm publish "--@nelsonlongxiang:registry=https://registry.npmjs.org" --access public

echo "== npmjs propagation (GET only; never retries publish) =="
ok=0
for i in 1 2 3 4 5 6; do
  sleep 55
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/@nelsonlongxiang%2Fdsh-prompt-templates/${ver}")
  echo "GET attempt $i: $code"
  if [ "$code" = 200 ]; then ok=1; break; fi
  [ "$code" = 404 ] || { echo "unexpected registry GET; inspect without republishing" >&2; exit 4; }
done
[ "$ok" = 1 ] || { echo "publish accepted but propagation unconfirmed; inspect GET, do not republish" >&2; exit 4; }

echo "== push + tag + GitHub Release =="
guard assert "$plan"
bash scripts/push-master.sh
# Re-read remote/local tags immediately before creating/pushing anything.
plan=$(guard finalize "$plan")
if ! git show-ref --verify --quiet "refs/tags/v${ver}"; then
  git tag "v${ver}" "$release_head"
fi
# A conflicting tag created while this process ran still fails here.
plan=$(guard finalize "$plan")
if [ "$(guard field "$plan" remote-tag)" = 0 ]; then
  git push github "v${ver}"
else
  echo "remote version tag already points to the verified commit; no push"
fi
if gh release view "v${ver}" --repo NelsonLongXiang/dsh-prompt-templates >/dev/null 2>&1; then
  echo "GitHub Release already exists"
else
  gh release create "v${ver}" --repo NelsonLongXiang/dsh-prompt-templates --title "v${ver}" --notes-file "$notes"
fi

echo "== final =="
echo "private latest: $(npm view @nelsonlongxiang/dsh-prompt-templates version)"
echo "npmjs latest: $(npm view @nelsonlongxiang/dsh-prompt-templates version '--@nelsonlongxiang:registry=https://registry.npmjs.org')"
