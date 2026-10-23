import React, { useCallback, useEffect, useRef, useState } from 'react';
import { playHls } from '../lib/hls.js';

const api = window.api;
const PRELOAD_AHEAD = 3;  // 当前部之后，提前准备 3 部
const PRELOAD_BEHIND = 1; // 上一部也留着，回滑秒开

function clean(e) {
  const raw = e?.message || String(e);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/**
 * 竖滑沉浸流：每部剧占满一屏，scroll-snap 吸附；停在某部约 0.4s 自动播它第 1 集。
 * 只给当前激活 slide 挂 <video>，其余显示竖版封面；滑走即 cancel，防资源堆积。
 */
export default function Reels({
  items, loading, hasMore, onMore, onOpen, paused = false, previewAtRef, hidden = false,
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const cleanupRef = useRef(null);
  const requestedRef = useRef(new Set()); // 已发起 prepare 的 vid，离开预加载窗口时 cancel
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState('idle'); // idle|loading|ready|error
  const [message, setMessage] = useState('');
  const [previewPaused, setPreviewPaused] = useState(false); // 用户手动暂停了当前预览

  // 分类/身份切换后 items 会整体替换；首条变化时回到顶部，避免停在旧的 active 下标。
  const firstId = items[0]?.series_id || '';
  useEffect(() => {
    setActive(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [firstId]);

  // 切走只隐藏(display:none)、不卸载；切回时按 active 恢复滚动位置
  // （display:none 可能清掉 scrollTop，这里用 active*一屏高 确定性复位）。
  useEffect(() => {
    if (hidden) return undefined;
    const id = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = active * (el.clientHeight || 0);
    });
    return () => cancelAnimationFrame(id);
  }, [hidden]);

  // 打开播放器时暂停预览，避免和 Player 同时出声/同时播放。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) { video.pause(); return; }
    if (status === 'ready') {
      // 从播放器关闭回到竖滑：若播放器在第 1 集推进了进度，seek 过去，保持两边一致。
      const saved = previewAtRef?.current;
      const activeVid = items[active]?.vid;
      if (saved && saved.vid && saved.vid === activeVid && saved.t > video.currentTime + 0.5) {
        try { video.currentTime = saved.t; } catch { /* noop */ }
      }
      video.play().catch(() => {});
    }
  }, [paused, status]);

  // 滚动 -> 计算当前激活 slide（每屏一部）。
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    const idx = Math.round(el.scrollTop / h);
    setActive((prev) => (idx !== prev ? idx : prev));
  }, []);

  // 临近末尾加载更多。
  useEffect(() => {
    if (hasMore && !loading && active >= items.length - 2) onMore();
  }, [active, hasMore, loading, items.length, onMore]);

  // 抖音式预加载窗口：当前 + 后 3 + 前 1。
  // 当前部最先入队，保证它优先拿转码 slot；离开窗口的 vid 取消，避免滑很快时堆积。
  useEffect(() => {
    const wanted = [];
    const max = Math.min(items.length - 1, active + PRELOAD_AHEAD);
    for (let i = active; i <= max; i++) wanted.push(items[i]);
    if (active - 1 >= 0 && active - PRELOAD_BEHIND >= 0) {
      for (let i = active - 1; i >= Math.max(0, active - PRELOAD_BEHIND); i--) wanted.push(items[i]);
    }

    const want = new Set(wanted.filter((it) => it?.vid).map((it) => it.vid));
    for (const vid of [...requestedRef.current]) {
      if (!want.has(vid)) {
        requestedRef.current.delete(vid);
        api.cancel(vid).catch(() => {});
      }
    }
    for (const it of wanted) {
      if (!it?.vid || requestedRef.current.has(it.vid)) continue;
      requestedRef.current.add(it.vid);
      api.prepare(it.vid).catch(() => { requestedRef.current.delete(it.vid); });
    }
  }, [active, items]);

  // 离开竖滑时取消所有还在准备的任务。
  useEffect(() => () => {
    for (const vid of requestedRef.current) api.cancel(vid).catch(() => {});
    requestedRef.current.clear();
  }, []);

  // 激活项变化：120ms 防抖后 prepare + 自动播第 1 集；预加载由上面的窗口负责。
  useEffect(() => {
    const item = items[active];
    if (!item?.vid) return undefined;
    let cancelled = false;
    setStatus('loading');
    setMessage('');
    setPreviewPaused(false); // 切到新一部，恢复“自动播放”态

    const timer = setTimeout(async () => {
      try {
        const info = await api.prepare(item.vid);
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
        cleanupRef.current = playHls(video, info.hlsUrl, {
          onReady: () => { if (!cancelled) setStatus('ready'); },
          onError: (msg) => { if (!cancelled) { setStatus('error'); setMessage(msg); } },
        });

      } catch (e) {
        if (!cancelled) { setStatus('error'); setMessage(clean(e)); }
      }
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    };
    // 只按“当前这一部的 vid”触发：列表尾部 append（加载更多）不应重启正在放的预览。
  }, [active, items[active]?.vid]);

  // “看这部”：点进全屏播放器，把当前预览进度一起带过去续播；非当前 slide 从 0 开始。
  const open = (i) => {
    const t = i === active && videoRef.current ? videoRef.current.currentTime : 0;
    onOpen(i, Number.isFinite(t) ? t : 0);
  };

  // 点视频区：暂停/恢复当前预览（不进播放器）。
  const togglePreview = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play().catch(() => {}); setPreviewPaused(false); }
    else { video.pause(); setPreviewPaused(true); }
  };

  if (items.length === 0) {
    return (
      <div className="reels-empty" style={hidden ? { display: 'none' } : undefined}>
        {loading ? '加载中…' : '暂无内容'}
      </div>
    );
  }

  return (
    <div
      className="reels"
      ref={containerRef}
      onScroll={onScroll}
      style={hidden ? { display: 'none' } : undefined}
    >
      {items.map((it, i) => (
        <section className="reel-slide" key={it.series_id || i}>
          <div className="reel-stage" onClick={() => { if (i === active) togglePreview(); }}>
            {i === active ? (
              <video
                ref={videoRef}
                className="reel-video"
                playsInline
                autoPlay
                poster={it.cover || undefined}
                onEnded={() => onOpen(active, 0, 1)}
              />
            ) : it.cover ? (
              <img className="reel-poster" src={it.cover} alt="" />
            ) : (
              <div className="reel-poster ph" />
            )}
            {i === active && previewPaused && <div className="reel-playicon">▶</div>}
            {i === active && status === 'loading' && <div className="reel-mask">准备 1080p…</div>}
            {i === active && status === 'error' && (
              <div className="reel-mask error">播放失败<div className="small">{message}</div></div>
            )}
          </div>
          <div className="reel-overlay">
            <div className="reel-title">{it.title}</div>
            <div className="reel-sub">
              {it.episode_cnt ? `${it.episode_cnt}集` : ''}
              {it.category ? ` · ${it.category}` : ''}
            </div>
            {it.intro ? <div className="reel-intro">{it.intro}</div> : null}
            <button className="reel-play" onClick={() => open(i)}>▶ 看这部</button>
          </div>
        </section>
      ))}
    </div>
  );
}
