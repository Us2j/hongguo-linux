# signer/lib

公开仓库不包含以下运行资源：

- `libmetasec_ml.so`
- `libc++_shared.so`
- `ms_16777218.bin`

它们来自红果 APK，属于字节/红果的专有材料，不能随公开仓库分发。

本地运行时，请从**你自己合法获得的 APK** 中提取：

```bash
APK=/path/to/com.phoenix.read_7.4.1.32.apk
unzip -p "$APK" lib/armeabi-v7a/libmetasec_ml.so > signer/lib/libmetasec_ml.so
unzip -p "$APK" lib/armeabi-v7a/libc++_shared.so > signer/lib/libc++_shared.so
# ms_16777218.bin 的位置随版本可能不同：
unzip -l "$APK" | grep ms_16777218.bin
```

或使用：

```bash
APK=/path/to/app.apk ./tools/setup-assets.sh
```

这些文件已加入 `.gitignore`，不要提交、不要公开分享。
