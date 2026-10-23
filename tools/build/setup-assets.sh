#!/usr/bin/env bash
# 从你合法获得的 APK 中提取本地运行资源；不下载、不分发专有二进制。
#
#   APK=/path/to/com.phoenix.read_7.4.1.32.apk ./tools/build/setup-assets.sh
#   UNIDBG_LIBS_JAR=/path/to/unidbg-libs.jar ./tools/build/setup-assets.sh
#   FFMPEG_BIN=/path/to/ffmpeg ./tools/build/setup-assets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APK="${APK:-}"
LIB="$ROOT/signer/lib"
mkdir -p "$LIB" "$ROOT/vendor" "$ROOT/resources"

log()  { printf '[setup] %s\n' "$*"; }
warn() { printf '[setup] WARN: %s\n' "$*" >&2; }

if [ -n "$APK" ]; then
  [ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }
  command -v unzip >/dev/null || { echo "需要 unzip" >&2; exit 1; }
  log "从 APK 提取: $APK"

  so_path=$(unzip -Z1 "$APK" | grep -E '(^|/)libmetasec_ml\.so$' | head -1 || true)
  cpp_path=$(unzip -Z1 "$APK" | grep -E '(^|/)libc\+\+_shared\.so$' | head -1 || true)
  cert_path=$(unzip -Z1 "$APK" | grep -E '(^|/)ms_16777218\.bin$' | head -1 || true)

  [ -n "$so_path" ] || { echo "APK 里没有 libmetasec_ml.so" >&2; exit 1; }
  unzip -p "$APK" "$so_path" > "$LIB/libmetasec_ml.so"
  log "  -> signer/lib/libmetasec_ml.so"

  if [ -n "$cpp_path" ]; then
    unzip -p "$APK" "$cpp_path" > "$LIB/libc++_shared.so"
    log "  -> signer/lib/libc++_shared.so"
  else
    warn "APK 里没有 libc++_shared.so"
  fi

  if [ -n "$cert_path" ]; then
    unzip -p "$APK" "$cert_path" > "$LIB/ms_16777218.bin"
    log "  -> signer/lib/ms_16777218.bin"
  else
    warn "APK 里没有 ms_16777218.bin（版本差异，可能无需或路径不同）"
  fi
else
  warn "未设置 APK；跳过了 .so / ms_16777218.bin 提取"
  warn "示例: APK=/path/to/app.apk $0"
fi

if [ -n "${UNIDBG_LIBS_JAR:-}" ]; then
  [ -f "$UNIDBG_LIBS_JAR" ] || { echo "UNIDBG_LIBS_JAR not found: $UNIDBG_LIBS_JAR" >&2; exit 1; }
  cp "$UNIDBG_LIBS_JAR" "$ROOT/vendor/unidbg-libs.jar"
  log "  -> vendor/unidbg-libs.jar"
elif [ ! -f "$ROOT/vendor/unidbg-libs.jar" ]; then
  warn "缺少 vendor/unidbg-libs.jar；请从 unidbg 上游构建/获取，见 vendor/README.md"
fi

if [ -n "${FFMPEG_BIN:-}" ]; then
  [ -f "$FFMPEG_BIN" ] || { echo "FFMPEG_BIN not found: $FFMPEG_BIN" >&2; exit 1; }
  cp "$FFMPEG_BIN" "$ROOT/resources/ffmpeg"
  chmod +x "$ROOT/resources/ffmpeg"
  log "  -> resources/ffmpeg"
elif ! command -v ffmpeg >/dev/null; then
  warn "系统没有 ffmpeg；开发可安装 ffmpeg，打包需 resources/ffmpeg，见 resources/README.md"
fi

log "完成。下一步："
log "  bash signer/build.sh"
log "  npm run dev"
