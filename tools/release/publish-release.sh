#!/usr/bin/env bash
# publish-release.sh — 把 release/ 下的构建产物发布到 GitHub Release。
# 只上传二进制，不碰源码（建仓/推源码请自行完成）。
set -euo pipefail

# ---- 定位仓库根 ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# ---- 默认参数 ----
REPO=""              # owner/name；留空则从 git remote origin 解析
TAG=""               # 留空则用 v<package.json version>
NOTES=""             # 描述文件；留空则用 release-notes/v<version>.md
DRAFT=0
PRERELEASE=0
PUSH_TAG=0
DRY_RUN=0

usage() {
  cat <<'EOF'
用法: bash tools/release/publish-release.sh [选项]

把用户版产物（release/user/Hongguo-User-*）上传到 GitHub Release。

选项:
  --repo owner/name   指定目标仓库（默认从 git remote origin 解析）
  --tag vX.Y.Z        指定标签（默认 v<package.json version>）
  --notes 文件         指定描述文件（默认 release-notes/v<version>.md）
  --draft             发布为草稿
  --prerelease        标记为预发布
  --push-tag          发布前把本地 tag push 到 origin（需已配置 remote）
  --dry-run           只打印将执行的命令，不实际发布
  -h, --help          显示本帮助

示例:
  bash tools/release/publish-release.sh --dry-run
  bash tools/release/publish-release.sh --repo Goingjiang/hongguo-linux
EOF
}

# ---- 解析参数 ----
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)       REPO="${2:?--repo 需要 owner/name}"; shift 2 ;;
    --tag)        TAG="${2:?--tag 需要 vX.Y.Z}"; shift 2 ;;
    --notes)      NOTES="${2:?--notes 需要文件路径}"; shift 2 ;;
    --draft)      DRAFT=1; shift ;;
    --prerelease) PRERELEASE=1; shift ;;
    --push-tag)   PUSH_TAG=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "错误: $*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] '; printf '%q ' "$@"; printf '\n'
  else
    "$@"
  fi
}

# ---- 前置校验 ----
command -v gh >/dev/null 2>&1 || die "未找到 gh（GitHub CLI），请先安装。"
gh auth status >/dev/null 2>&1 || die "gh 未登录，请先运行: gh auth login"

# ---- 版本 / 标签 ----
if command -v jq >/dev/null 2>&1; then
  VERSION="$(jq -r '.version' package.json)"
else
  VERSION="$(node -p "require('./package.json').version")"
fi
[ -n "$VERSION" ] && [ "$VERSION" != "null" ] || die "无法从 package.json 读取 version。"
[ -n "$TAG" ] || TAG="v$VERSION"

# ---- 目标仓库 ----
if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  [ -n "$REPO" ] || die "无法解析目标仓库。请先推源码并配置 git remote origin，或用 --repo owner/name 指定。"
fi

# ---- 产物：只发用户版（release/user/Hongguo-User-*）----
# 用户版仅内置模拟器身份池（emu-*）；local 版含真机身份，禁止发布。
RELEASE_DIR="release/user"
[ -d "$RELEASE_DIR" ] || die "缺少目录 $RELEASE_DIR（请先构建用户版: npm run package:user）"

shopt -s nullglob
APPIMAGES=("$RELEASE_DIR"/Hongguo-User-*.AppImage)
DEBS=("$RELEASE_DIR"/Hongguo-User-*.deb)
shopt -u nullglob

[ "${#APPIMAGES[@]}" -ge 1 ] || die "未找到用户版 AppImage: $RELEASE_DIR/Hongguo-User-*.AppImage"
[ "${#DEBS[@]}" -ge 1 ]      || die "未找到用户版 deb: $RELEASE_DIR/Hongguo-User-*.deb"
[ "${#APPIMAGES[@]}" -eq 1 ] || die "匹配到多个用户版 AppImage，请清理旧产物: ${APPIMAGES[*]}"
[ "${#DEBS[@]}" -eq 1 ]      || die "匹配到多个用户版 deb，请清理旧产物: ${DEBS[*]}"

ARTIFACTS=("${APPIMAGES[0]}" "${DEBS[0]}")

# 现场生成 SHA256SUMS（裸文件名，便于下载后在同目录 sha256sum -c 校验）
SUMS_FILE="$RELEASE_DIR/SHA256SUMS"
echo "==> 生成 $SUMS_FILE"
if [ "$DRY_RUN" -eq 0 ]; then
  ( cd "$RELEASE_DIR" && sha256sum "$(basename "${APPIMAGES[0]}")" "$(basename "${DEBS[0]}")" > SHA256SUMS )
  cat "$SUMS_FILE"
  ARTIFACTS+=("$SUMS_FILE")
else
  echo "[dry-run] ( cd $RELEASE_DIR && sha256sum Hongguo-User-*.AppImage Hongguo-User-*.deb > SHA256SUMS )"
fi

# ---- 标签 ----
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "==> 创建本地 tag $TAG"
  run git tag "$TAG"
fi
if [ "$PUSH_TAG" -eq 1 ]; then
  echo "==> push tag $TAG 到 origin"
  run git push origin "$TAG"
fi

# ---- Release notes（默认 release-notes/v<version>.md，可用 --notes 覆盖）----
NOTES_FILE="${NOTES:-release-notes/v$VERSION.md}"
[ -f "$NOTES_FILE" ] || die "缺少描述文件: $NOTES_FILE（可用 --notes 指定其它文件）"

# ---- 发布 ----
echo "==> 目标仓库: $REPO"
echo "==> 标签:     $TAG"
echo "==> 产物:     ${ARTIFACTS[*]}"

CREATE_FLAGS=(--repo "$REPO" --title "Hongguo $TAG" --notes-file "$NOTES_FILE")
[ "$DRAFT" -eq 1 ] && CREATE_FLAGS+=(--draft)
[ "$PRERELEASE" -eq 1 ] && CREATE_FLAGS+=(--prerelease)

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "==> Release $TAG 已存在，更新描述并使用 --clobber 补传产物"
  run gh release edit "$TAG" --repo "$REPO" --notes-file "$NOTES_FILE"
  run gh release upload "$TAG" --repo "$REPO" --clobber "${ARTIFACTS[@]}"
else
  echo "==> 创建 Release $TAG 并上传产物"
  run gh release create "$TAG" "${CREATE_FLAGS[@]}" "${ARTIFACTS[@]}"
fi

if [ "$DRY_RUN" -eq 0 ]; then
  URL="$(gh release view "$TAG" --repo "$REPO" --json url -q .url 2>/dev/null || true)"
  [ -n "$URL" ] && echo "==> 完成: $URL"
else
  echo "[dry-run] 未实际发布。"
fi
