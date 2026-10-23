#!/usr/bin/env bash
# 用 Android AVD 跑一次官方 App，导出设备身份并验证搜索。
#
#   AVD=hgx86 ./tools/device/register_emulator.sh
#   AVD=hgarm PORT=5558 ./tools/device/register_emulator.sh
#   KEEP=1 AVD=hgx86 ./tools/device/register_emulator.sh     # 跑完保留模拟器
#   ACCEL=on AVD=hgx86 ./tools/device/register_emulator.sh   # 强制 KVM
#
# 依赖: adb、Android SDK emulator、AVD、红果 APK。
#
# 重要：140MB APK + 25 dex，**强烈建议 KVM**。没有 /dev/kvm 时使用 TCG，
# 启动/安装/注册可能需要 30–60 分钟，且容易触发 system_server/SystemUI ANR。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="$(cd "$ROOT/.." && pwd)"
AVD="${AVD:-hgx86}"
PORT="${PORT:-5556}"
SERIAL="emulator-${PORT}"
APK="${APK:-$PROJECT/com.phoenix.read_7.4.1.32.apk}"
EMULATOR_BIN="${EMULATOR_BIN:-$HOME/Android/Sdk/emulator/emulator}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-900}"
REG_TIMEOUT="${REG_TIMEOUT:-600}"
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-900}"
KEEP="${KEEP:-0}"
OUT="${OUT:-}"                       # 非空时导出到该身份文件，不覆盖激活的 config/device.json
WIPE="${WIPE:-1}"                    # 冷启动时 -wipe-data 恢复出厂，逼服务端下发新 device_id
MEMORY="${MEMORY:-4096}"
CORES="${CORES:-4}"
LOG="${LOG:-$ROOT/cache/emulator-${AVD}.log}"
AVD_HOME="${AVD_HOME:-$ROOT/cache/avd}"
UI_XML="$ROOT/cache/ui-consent.xml"
export ANDROID_AVD_HOME="$AVD_HOME"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/dev/android-sdk}"
mkdir -p "$(dirname "$LOG")" "$AVD_HOME" "$(dirname "$UI_XML")"

log()  { printf '[emulator] %s\n' "$*"; }
fail() { printf '[emulator] ERROR: %s\n' "$*" >&2; exit 1; }
adb_s() { timeout 30 adb -s "$SERIAL" "$@"; }

[ -x "$EMULATOR_BIN" ] || EMULATOR_BIN="/opt/dev/android-sdk/emulator/emulator"
[ -x "$EMULATOR_BIN" ] || fail "找不到 emulator，设置 EMULATOR_BIN"
[ -f "$APK" ] || fail "找不到 APK: $APK"
command -v adb >/dev/null || fail "找不到 adb"

# 工作区 AVD：从 ~/.android 复制 config.ini，不复制 userdata，保证可写且干净。
prepare_avd() {
  [ -f "$AVD_HOME/$AVD.avd/config.ini" ] && return
  [ -f "$HOME/.android/avd/$AVD.avd/config.ini" ] || fail "AVD 不存在: $AVD"
  log "从 ~/.android/avd/$AVD 复制 AVD 配置到 $AVD_HOME"
  mkdir -p "$AVD_HOME/$AVD.avd"
  cp "$HOME/.android/avd/$AVD.avd/config.ini" "$AVD_HOME/$AVD.avd/config.ini"
  sed -i "s/^AvdId=.*/AvdId=$AVD/" "$AVD_HOME/$AVD.avd/config.ini"
  cat > "$AVD_HOME/$AVD.ini" <<INI
avd.ini.encoding=UTF-8
path=$AVD_HOME/$AVD.avd
path.rel=avd/$AVD.avd
target=android-30
INI
}
prepare_avd

# 有 KVM 就用；没有则 TCG（会提示很慢）。
if [ -n "${ACCEL:-}" ]; then
  :
elif [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  ACCEL=on
else
  ACCEL=off
fi
[ "$ACCEL" = "off" ] && log "警告：没有 /dev/kvm，使用 TCG；启动/安装可能非常慢"
log "ACCEL=$ACCEL MEMORY=$MEMORY CORES=$CORES"

STARTED=0
cleanup() {
  if [ "$STARTED" = "1" ] && [ "$KEEP" != "1" ]; then
    log "关闭模拟器 $SERIAL"
    adb -s "$SERIAL" emu kill >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if adb -s "$SERIAL" get-state >/dev/null 2>&1; then
  log "复用已连接的 $SERIAL"
else
  # -wipe-data 恢复出厂：实测这是让服务端下发【新】device_id 的唯一有效杠杆
  # （改 android_id / ro.serialno 无效：serialno 的 -prop 被模拟器忽略，android_id
  #  的 settings put 不影响 App 注册时读到的值；只有整盘 wipe 才换新 device_id）。
  WIPE_ARG=()
  [ "$WIPE" = "1" ] && WIPE_ARG=(-wipe-data) && log "使用 -wipe-data（会换新 device_id，首启稍慢）"
  log "启动 AVD=$AVD port=$PORT"
  "$EMULATOR_BIN" -avd "$AVD" \
    -port "$PORT" -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -accel "$ACCEL" \
    -no-snapshot "${WIPE_ARG[@]}" \
    -memory "$MEMORY" -cores "$CORES" -netdelay none -netspeed full \
    >"$LOG" 2>&1 &
  STARTED=1
fi

log "等待设备上线..."
for _ in $(seq 1 120); do
  if adb -s "$SERIAL" get-state >/dev/null 2>&1; then break; fi
  sleep 2
done
adb -s "$SERIAL" get-state >/dev/null 2>&1 || { tail -40 "$LOG" >&2 || true; fail "模拟器未上线"; }

log "等待 Android 启动完成（最多 ${BOOT_TIMEOUT}s）..."
deadline=$((SECONDS + BOOT_TIMEOUT))
boot=""
while [ "$SECONDS" -lt "$deadline" ]; do
  boot=$(adb_s shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
  [ "$boot" = "1" ] && break
  sleep 3
done
[ "${boot:-}" = "1" ] || { tail -60 "$LOG" >&2 || true; fail "Android 启动超时"; }
log "Android 已启动"

log "获取 root（Google APIs 镜像支持 adb root；Play 镜像不行）"
adb_s root >/dev/null 2>&1 || true
sleep 2
adb -s "$SERIAL" wait-for-device
uid_line=$(adb_s shell id | tr -d '\r')
log "$uid_line"
printf '%s' "$uid_line" | grep -q 'uid=0' || fail "adb root 失败（需要 Google APIs/userdebug 镜像）"

# 注：新 device_id 靠上面的 -wipe-data，不靠这里改 android_id（实测无效）。

log "安装 APK（push + pm install，禁用 dexopt 以降低超时）"
adb_s uninstall com.phoenix.read >/dev/null 2>&1 || true
adb_s push "$APK" /data/local/tmp/hongguo.apk >/dev/null
adb_s shell setprop pm.dexopt.install verify >/dev/null 2>&1 || true
install_out=$(timeout "$INSTALL_TIMEOUT" adb -s "$SERIAL" shell \
  'pm install -r --skip-verification /data/local/tmp/hongguo.apk' 2>&1 || true)
printf '%s\n' "$install_out" | tail -5 | sed 's/^/[emulator] /'
printf '%s' "$install_out" | grep -q 'Success' || fail "APK 安装失败（见上方输出）"
adb_s shell rm -f /data/local/tmp/hongguo.apk >/dev/null 2>&1 || true

# 从 UI 层级里找“同意并继续”并点击。
tap_consent() {
  adb_s shell 'uiautomator dump /sdcard/ui-consent.xml' >/dev/null 2>&1 || return 1
  adb -s "$SERIAL" pull /sdcard/ui-consent.xml "$UI_XML" >/dev/null 2>&1 || return 1
  local coords
  coords=$(python3 - "$UI_XML" <<'PY'
import re, sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(0)
for n in root.iter('node'):
    text = (n.get('text') or '') + ' ' + (n.get('content-desc') or '')
    if '同意并继续' in text or text.strip() == '同意':
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds', ''))
        if m:
            print((int(m.group(1)) + int(m.group(3))) // 2,
                  (int(m.group(2)) + int(m.group(4))) // 2)
            break
PY
)
  [ -n "$coords" ] || return 1
  # shellcheck disable=SC2086
  set -- $coords
  log "点击同意 ($1,$2)"
  adb_s shell "input tap $1 $2" >/dev/null 2>&1 || true
  return 0
}

log "启动 App"
component=$(adb_s shell 'cmd package resolve-activity --brief com.phoenix.read' 2>/dev/null | tail -1 | tr -d '\r')
[ -n "$component" ] || component='com.phoenix.read/com.dragon.read.pages.splash.SplashActivity'
adb_s shell "am start -n $component" >/dev/null 2>&1 || true

log "等待设备注册（最多 ${REG_TIMEOUT}s；会自动点“同意并继续”）..."
prefs="/data/data/com.phoenix.read/shared_prefs"
deadline=$((SECONDS + REG_TIMEOUT))
device_id=""
iter=0
while [ "$SECONDS" -lt "$deadline" ]; do
  xml=$(adb_s shell "cat $prefs/applog_stats.xml $prefs/ug_install_settings_pref.xml 2>/dev/null" 2>/dev/null | tr -d '\r' || true)
  # 注意：set -euo pipefail 下，grep 无匹配会使整条管道返回 1，
  # 在 var=$(...) 赋值里会直接触发 set -e 结束脚本——必须 || true 兜底。
  device_id=$(printf '%s' "$xml" | grep -o '<string name="device_id">[^<]*' | head -1 | sed 's/.*>//' || true)
  [ -n "$device_id" ] && break
  # 确保 App 在前台：接受隐私弹窗后 App 会退回桌面，需周期性重新拉起，
  # 否则弹窗不在前台时既点不到“同意并继续”，也无法完成后台注册。
  if [ $((iter % 5)) -eq 0 ]; then
    adb_s shell "am start -n $component" >/dev/null 2>&1 || true
  fi
  tap_consent || true
  iter=$((iter + 1))
  sleep 3
done
if [ -z "$device_id" ]; then
  log "未等到注册，最近日志："
  adb_s logcat -d -t 300 2>/dev/null | grep -iE "phoenix|applog|register|metasec|ANR" | tail -40 >&2 || true
  fail "App 未完成注册（可能需要手动点同意/网络/模拟器被检测/TCG 太慢）"
fi
log "已注册 device_id=$device_id"

# OUT 非空：写到指定身份文件，不动激活身份，也不需要备份。
# OUT 为空（旧用法）：覆盖 config/device.json，覆盖前把旧身份备份到 config/backups/。
if [ -n "$OUT" ]; then
  DEST="$OUT"
else
  DEST="$ROOT/config/device.json"
  if [ -f "$DEST" ]; then
    mkdir -p "$ROOT/config/backups"
    backup="$ROOT/config/backups/device-$(date +%Y%m%d-%H%M%S).json"
    cp "$DEST" "$backup"
    log "已备份原身份: $backup"
  fi
fi

log "导出身份到 $DEST"
node "$ROOT/tools/device/register.mjs" --from-device "$SERIAL" --out "$DEST"

log "搜索验证（针对刚导出的身份）"
if HG_DEVICE_CONFIG="$DEST" timeout 180 node "$ROOT/bin/hongguo.mjs" search "总裁" --pages 1; then
  log "搜索验证完成"
else
  log "搜索验证失败；可检查 config/device.json 的 profile 是否与模拟器一致"
  exit 1
fi
