#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
CP="../vendor/unidbg-libs.jar"
if [ ! -f "$CP" ]; then
  echo "missing $CP" >&2
  echo "公开仓库不附带该 jar；请见 vendor/README.md，或用 UNIDBG_LIBS_JAR 运行 tools/setup-assets.sh" >&2
  exit 1
fi
for f in lib/libmetasec_ml.so lib/libc++_shared.so lib/ms_16777218.bin; do
  [ -f "$f" ] || echo "warning: missing $f (runtime signer will fail; see signer/lib/README.md)" >&2
done
mkdir -p out
javac --release 17 -encoding UTF-8 -cp "$CP" -d out src/dev/hongguo/sign/MetasecHarness.java
echo "built: signer/out"
