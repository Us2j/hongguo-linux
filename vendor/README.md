# vendor

公开仓库不包含以下第三方/专有运行资源：

- `unidbg-libs.jar`
- `unidbg-sign.jar`
- 任何 `.so` / `.jar` / APK / 设备配置

## unidbg-libs.jar

本地签名 harness 需要 unidbg 及其依赖。请从 unidbg 上游构建或获取，并保留其
`META-INF` 许可证/notice 文件。可通过环境变量指定已有 jar：

```bash
UNIDBG_LIBS_JAR=/path/to/unidbg-libs.jar ./tools/setup-assets.sh
```

## .so 与 ms_16777218.bin

从**你自己合法获得的红果 APK** 中提取到 `signer/lib/`，见
[`signer/lib/README.md`](../signer/lib/README.md)。

## unidbg-sign.jar

本项目**不需要** `unidbg-sign.jar`；不要使用或分发来源不明的签名 jar。

## ffmpeg

开发时用系统 `ffmpeg` 即可；打包时需要 `resources/ffmpeg`，见
[`resources/README.md`](../resources/README.md)。

## 提醒

这些文件不适用本项目的 MIT 许可证。公开分发前请确认你有权分发，并保留所有
第三方许可证和 notice。
