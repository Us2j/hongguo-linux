#!/usr/bin/env bash
# 按 profile 打包：烘焙身份库 + 裁剪 JRE + 静态 ffmpeg + 签名资源自检 + electron-builder。
#
#   bash tools/build/package.sh local [active]   # 本地版：含全部身份，active 默认真机 real-837613c6
#   bash tools/build/package.sh user  [active]   # 用户版：仅模拟器身份池(emu-*)，active 默认 emu-01，自带 rotate
#
# 产物在 release/<profile>/（AppImage + deb）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PROFILE="${1:?用法: bash tools/build/package.sh <local|user> [active]}"
ACTIVE="${2:-}"
log() { printf '[package] %s\n' "$*"; }
case "$PROFILE" in local|user) ;; *) echo "[package] profile 只能是 local 或 user" >&2; exit 1 ;; esac

# 1) 身份库（resources/seed/config）。
log "组装身份库 profile=$PROFILE${ACTIVE:+ active=$ACTIVE}…"
node tools/build/build-seed.mjs "$PROFILE" ${ACTIVE:+"$ACTIVE"}

# 2) 裁剪 JRE。
if [ -x resources/jre/bin/java ]; then log "复用 resources/jre"; else log "生成裁剪 JRE (jlink)…"; npm run build:jre; fi

# 3) 静态 ffmpeg。
if [ -x node_modules/ffmpeg-static/ffmpeg ]; then
  cp node_modules/ffmpeg-static/ffmpeg resources/ffmpeg
  chmod +x resources/ffmpeg
  if file resources/ffmpeg 2>/dev/null | grep -q 'statically linked'; then log "静态 ffmpeg OK"; else log "警告: ffmpeg 非静态"; fi
else
  log "缺 node_modules/ffmpeg-static/ffmpeg（npm i -D ffmpeg-static && node node_modules/ffmpeg-static/install.js）"
  if [ ! -x resources/ffmpeg ] && command -v ffmpeg >/dev/null 2>&1; then
    cp "$(command -v ffmpeg)" resources/ffmpeg && chmod +x resources/ffmpeg && log "回退系统 ffmpeg（非静态，不保证可移植）"
  fi
fi
[ -x resources/ffmpeg ] || { echo "[package] 缺 resources/ffmpeg" >&2; exit 1; }

# 4) 签名原生资源自检。
for f in signer/out/dev/hongguo/sign/MetasecHarness.class signer/lib/libmetasec_ml.so \
         signer/lib/libc++_shared.so vendor/unidbg-libs.jar; do
  [ -e "$f" ] || { echo "[package] 缺签名资源: $f（先 npm run build:signer）" >&2; exit 1; }
done
log "签名资源齐全"

# 5) 构建渲染层 + 打包到 release/<profile>。
log "构建渲染层…"
npm run build:renderer

# 每个 profile 独立 appId / 应用名 / 可执行名 → 独立 userData，两个包装在同一台机器也互不覆盖。
APPID="com.hongguo.$PROFILE"
APPNAME="hongguo-$PROFILE"
case "$PROFILE" in
  local) PRODUCT="Hongguo-Local" ;;
  user)  PRODUCT="Hongguo-User" ;;
esac
log "electron-builder → release/$PROFILE  (appId=$APPID, productName=$PRODUCT, 数据目录独立)…"
npx electron-builder --linux \
  -c.directories.output="release/$PROFILE" \
  -c.appId="$APPID" \
  -c.productName="$PRODUCT" \
  -c.executableName="$APPNAME" \
  -c.extraMetadata.name="$APPNAME"

log "完成，产物："
ls -1 "release/$PROFILE"/*.AppImage "release/$PROFILE"/*.deb 2>/dev/null || true
