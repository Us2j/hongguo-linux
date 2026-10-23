#!/usr/bin/env bash
# 构建 Linux 通用包（x86_64）：
#   TARGET=appimage  -> release/Hongguo-<version>.AppImage   (Arch / Ubuntu 通用)
#   TARGET=deb       -> release/Hongguo-<version>.deb        (Ubuntu/Debian)
#   TARGET=both      -> 两个都构建（默认）
#
#   ./tools/build/build-linux.sh
#   ASSETS_DIR=/path/to/private-assets ./tools/build/build-linux.sh
#   APK=/path/to/app.apk UNIDBG_LIBS_JAR=/path/to/unidbg-libs.jar ./tools/build/build-linux.sh
#
# 公开仓库不包含 .so / jar / ffmpeg；脚本会从本地私有资源目录或用户提供的
# APK/JAR 恢复它们，只写到被 .gitignore 忽略的位置，不会提交。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TARGET="${TARGET:-both}"
ASSETS_DIR="${ASSETS_DIR:-$ROOT/../.private-assets/hongguo-linux}"
ARCH="$(uname -m)"
LOG="$ROOT/release/build-linux.log"
mkdir -p "$ROOT/release"

log()  { printf '[build-linux] %s\n' "$*"; }
die()  { printf '[build-linux] ERROR: %s\n' "$*" >&2; exit 1; }
have() { [ -e "$1" ]; }

[ "$ARCH" = "x86_64" ] || die "当前资源是 x86_64；当前架构 $ARCH，暂不支持"
command -v node >/dev/null || die "找不到 node"
command -v npm  >/dev/null || die "找不到 npm"

# 公开仓库删除了专有资源；这里从本地私有目录复制（保留在原处，不提交）。
restore_assets() {
  log "检查签名/媒体资源..."
  for f in libmetasec_ml.so libc++_shared.so ms_16777218.bin; do
    if ! have "signer/lib/$f"; then
      if have "$ASSETS_DIR/signer/lib/$f"; then
        cp -a "$ASSETS_DIR/signer/lib/$f" "signer/lib/$f"
        log "  restored signer/lib/$f"
      else
        log "  missing signer/lib/$f"
      fi
    fi
  done

  if ! have "vendor/unidbg-libs.jar"; then
    if [ -n "${UNIDBG_LIBS_JAR:-}" ] && have "$UNIDBG_LIBS_JAR"; then
      cp -a "$UNIDBG_LIBS_JAR" "vendor/unidbg-libs.jar"
      log "  restored vendor/unidbg-libs.jar (UNIDBG_LIBS_JAR)"
    elif have "$ASSETS_DIR/vendor/unidbg-libs.jar"; then
      cp -a "$ASSETS_DIR/vendor/unidbg-libs.jar" "vendor/unidbg-libs.jar"
      log "  restored vendor/unidbg-libs.jar"
    else
      log "  missing vendor/unidbg-libs.jar"
    fi
  fi

  if ! have "resources/ffmpeg"; then
    if have "$ASSETS_DIR/resources/ffmpeg"; then
      cp -a "$ASSETS_DIR/resources/ffmpeg" "resources/ffmpeg"
      log "  restored resources/ffmpeg"
    elif have "node_modules/ffmpeg-static/ffmpeg"; then
      cp -a "node_modules/ffmpeg-static/ffmpeg" "resources/ffmpeg"
      log "  copied ffmpeg-static -> resources/ffmpeg"
    elif command -v ffmpeg >/dev/null 2>&1; then
      cp "$(command -v ffmpeg)" "resources/ffmpeg"
      log "  WARN: 使用系统 ffmpeg（可能动态链接，不保证跨发行版）"
    else
      log "  missing resources/ffmpeg"
    fi
  fi
  chmod +x resources/ffmpeg 2>/dev/null || true

  if ! have "resources/jre/bin/java"; then
    if command -v jlink >/dev/null 2>&1; then
      log "生成裁剪 JRE (jlink)..."
      npm run build:jre
    else
      log "  missing resources/jre/bin/java，且找不到 jlink"
    fi
  fi

  if [ -n "${APK:-}" ] && [ -f "$APK" ]; then
    log "用 APK 提取缺失的 .so / ms_16777218.bin..."
    APK="$APK" bash tools/build/setup-assets.sh || true
  fi

  local missing_now=()
  for f in signer/lib/libmetasec_ml.so signer/lib/libc++_shared.so signer/lib/ms_16777218.bin \
           vendor/unidbg-libs.jar resources/ffmpeg resources/jre/bin/java; do
    have "$f" || missing_now+=("$f")
  done
  if [ "${#missing_now[@]}" -gt 0 ]; then
    die "缺少运行资源: ${missing_now[*]}
请设置 ASSETS_DIR，或提供 APK/UNIDBG_LIBS_JAR；见 vendor/README.md、signer/lib/README.md、resources/README.md"
  fi
}

# 依赖
if [ ! -x node_modules/.bin/electron-builder ] || [ ! -d node_modules/electron ]; then
  log "安装 npm 依赖..."
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

# 资源（签名 harness 需要 jar/.so）
restore_assets

# 签名 harness
log "编译签名 harness..."
npm run build:signer

# 渲染层
log "构建 renderer..."
npm run build:renderer

# electron-builder
case "$TARGET" in
  appimage) targets=(AppImage) ;;
  deb)      targets=(deb) ;;
  both)     targets=(AppImage deb) ;;
  *)        die "TARGET 只能是 appimage|deb|both" ;;
esac

log "electron-builder: ${targets[*]}"
set +e
./node_modules/.bin/electron-builder --linux "${targets[@]}" --publish never 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e
[ "$rc" -eq 0 ] || { tail -40 "$LOG" >&2 || true; die "electron-builder 失败，日志: $LOG"; }

log "构建完成："
ls -lh release/*.AppImage release/*.deb 2>/dev/null || true
log "AppImage 可在 Arch/Ubuntu x86_64 运行："
log "  chmod +x release/Hongguo-*.AppImage && ./release/Hongguo-*.AppImage"
log "Ubuntu/Debian 也可安装 .deb。"
