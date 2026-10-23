import Hls from 'hls.js';

/**
 * 把 HLS 地址挂到 <video> 上播放，返回清理函数。
 * Player（全屏）与 Reels（竖滑）共用，统一 hls.js 的加载/错误处理。
 */
export function playHls(video, url, { onReady, onError, autoplay = true, startPosition = 0 } = {}) {
  let hls = null;

  if (Hls.isSupported()) {
    // event playlist 会不断增长；不指定 startPosition 时 hls.js 会从 live edge 起播，
    // 预览播了一会再点进播放器就会“接着后面的进度”。这里强制从头开始。
    hls = new Hls({ lowLatencyMode: false, enableWorker: true, startPosition });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      onReady?.();
      if (autoplay) video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) onError?.(`${data.type}: ${data.details}`);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    onReady?.();
    if (autoplay) video.play().catch(() => {});
  } else {
    onError?.('浏览器不支持 HLS');
  }

  return () => { if (hls) { hls.destroy(); hls = null; } };
}
