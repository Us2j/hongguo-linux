# resources

公开仓库不包含：

- `ffmpeg`（GPLv3 静态构建，约 77MB）
- `jre/`（jlink 裁剪的 Java 运行时）

## 开发

系统有 `ffmpeg` 即可：

```bash
ffmpeg -version
```

或用 `ffmpeg-static`：

```bash
npm install
node -e "console.log(require('ffmpeg-static'))"
```

## 打包

`npm run dist` 需要：

```text
resources/ffmpeg
resources/jre/bin/java
```

可自行准备：

```bash
# 方式一：系统 ffmpeg
cp "$(command -v ffmpeg)" resources/ffmpeg

# 方式二：ffmpeg-static
cp node_modules/ffmpeg-static/ffmpeg resources/ffmpeg

# JRE
npm run build:jre
```

FFmpeg 是 GPLv3 构建，分发时需遵守 GPL；见根目录 `NOTICE` 和
`LICENSES/GPL-3.0.txt`。
