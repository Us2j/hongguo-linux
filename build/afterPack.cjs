// electron-builder afterPack：校验运行期必需的原生资源都已随包。
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources');
  const required = [
    'signer/out/dev/hongguo/sign/MetasecHarness.class',
    'signer/lib/libmetasec_ml.so',
    'signer/lib/libc++_shared.so',
    'vendor/unidbg-libs.jar',
    'jre/bin/java',
    'ffmpeg',
  ];
  const missing = required.filter((r) => !fs.existsSync(path.join(resources, r)));
  if (missing.length) {
    throw new Error('[afterPack] 缺少打包资源:\n  ' + missing.join('\n  '));
  }
  console.log('[afterPack] 原生资源齐全: ' + required.join(', '));
};
