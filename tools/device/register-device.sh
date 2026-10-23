#!/usr/bin/env bash
# 本机自动注册一套红果设备身份，并写入 AppImage/deb 的用户数据目录。
#
#   ./tools/device/register-device.sh
#   AVD=hgx86 APK=/path/to/app.apk ./tools/device/register-device.sh
#   NO_TEST=1 ./tools/device/register-device.sh       # 跳过注册后的搜索复测
#   CHECK_ONLY=1 ./tools/device/register-device.sh    # 只检查环境，不启动模拟器
#
# 依赖：/dev/kvm、adb、Android emulator、AVD、红果 APK、Java、已编译的 signer。
# 这是“本机注册工具”，不是 AppImage 内置功能；普通用户仍需自己准备这些依赖。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

AVD="${AVD:-hgx86}"
PORT="${PORT:-5556}"
NO_TEST="${NO_TEST:-0}"
CHECK_ONLY="${CHECK_ONLY:-0}"
USER_DATA_DIR="${USER_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/hongguo-linux}"
TARGET_DIR="$USER_DATA_DIR/config"
TARGET="$TARGET_DIR/device.json"
NAME="${NAME:-device-$(date +%Y%m%d-%H%M%S)}"

log() { printf '[register-device] %s\n' "$*"; }
die() { printf '[register-device] ERROR: %s\n' "$*" >&2; exit 1; }

# APK：优先 APK 环境变量，其次项目父目录里的 com.phoenix.read_*.apk。
if [ -z "${APK:-}" ]; then
  APK="$(find "$ROOT/.." -maxdepth 1 -type f -name 'com.phoenix.read_*.apk' 2>/dev/null | head -1 || true)"
fi
[ -n "${APK:-}" ] || die "找不到 APK；请设置 APK=/path/to/app.apk"

# emulator 路径
if [ -z "${EMULATOR_BIN:-}" ]; then
  for p in "$HOME/Android/Sdk/emulator/emulator" /opt/dev/android-sdk/emulator/emulator; do
    if [ -x "$p" ]; then EMULATOR_BIN="$p"; break; fi
  done
fi
[ -n "${EMULATOR_BIN:-}" ] && [ -x "$EMULATOR_BIN" ] || die "找不到 Android emulator；设置 EMULATOR_BIN"

# adb
ADB="${ADB:-$(command -v adb || true)}"
if [ -z "$ADB" ] && [ -x "$HOME/Android/Sdk/platform-tools/adb" ]; then
  ADB="$HOME/Android/Sdk/platform-tools/adb"
fi
[ -n "$ADB" ] && [ -x "$ADB" ] || die "找不到 adb；安装 Android platform-tools 或设置 ADB"
# 让 identity.mjs / register_emulator.sh 里直接调用的 adb 也能找到。
export PATH="$(dirname "$ADB"):$PATH"
export ADB

# 必需检查
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm 不可读写；需要 KVM（不要在无 KVM 机器上跑 TCG）"
[ -f "$HOME/.android/avd/$AVD.avd/config.ini" ] || die "AVD 不存在: $AVD（可设置 AVD=...）"
[ -f "$APK" ] || die "APK 不存在: $APK"
command -v node >/dev/null || die "找不到 node"
command -v java >/dev/null || die "找不到 java"

# signer 资源（注册后的搜索复测需要）
if [ "$NO_TEST" != "1" ]; then
  [ -f vendor/unidbg-libs.jar ] || die "缺少 vendor/unidbg-libs.jar；见 vendor/README.md"
  [ -f signer/lib/libmetasec_ml.so ] || die "缺少 signer/lib/libmetasec_ml.so；见 signer/lib/README.md"
  [ -f signer/lib/libc++_shared.so ] || die "缺少 signer/lib/libc++_shared.so"
  [ -f signer/lib/ms_16777218.bin ] || die "缺少 signer/lib/ms_16777218.bin"
  if [ ! -f signer/out/dev/hongguo/sign/MetasecHarness.class ]; then
    command -v javac >/dev/null || die "缺少 signer/out 且找不到 javac"
    log "编译 signer..."
    npm run build:signer
  fi
fi

log "AVD=$AVD PORT=$PORT"
log "APK=$APK"
log "ADB=$ADB"
log "EMULATOR_BIN=$EMULATOR_BIN"
log "目标身份=$TARGET"

if [ "$CHECK_ONLY" = "1" ]; then
  log "CHECK_ONLY=1：环境检查通过，未启动模拟器"
  exit 0
fi

# 已有模拟器时 identity.mjs 会拒绝；先给出明确提示。
running="$("$ADB" devices 2>/dev/null | awk '/^emulator-[0-9]+[[:space:]]+device/{print $1}')"
[ -z "$running" ] || die "已有模拟器在运行: $running；先关闭: $ADB -s $running emu kill"

# 先备份 App 用户目录里的旧身份（如果存在）。
if [ -f "$TARGET" ]; then
  mkdir -p "$TARGET_DIR"
  bak="$TARGET.bak.$(date +%Y%m%d-%H%M%S)"
  cp -a "$TARGET" "$bak"
  chmod 600 "$bak"
  log "已备份旧身份: $bak"
fi

log "开始注册（会启动模拟器，可能需要几分钟）..."
new_args=(--name "$NAME" --avd "$AVD" --port "$PORT")
[ "$NO_TEST" = "1" ] && new_args+=(--no-test)

APK="$APK" AVD="$AVD" PORT="$PORT" EMULATOR_BIN="$EMULATOR_BIN" \
  node tools/device/identity.mjs new "${new_args[@]}"

# 激活到仓库的 config/device.json，再复制到 AppImage 的 userData。
log "激活身份 $NAME ..."
node tools/device/identity.mjs use "$NAME" --force

mkdir -p "$TARGET_DIR"
install -m 600 config/device.json "$TARGET"
chmod 600 "$TARGET"
log "已写入: $TARGET"
log "重启 Hongguo 后生效；搜索将使用新身份。"
