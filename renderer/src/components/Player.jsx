import React, { useEffect, useRef, useState } from 'react';
import { playHls } from '../lib/hls.js';

const api = window.api;

function clean(e) {
  const raw = e?.message || String(e);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/**
 * 播放器：上一集/下一集切换的是「同一部剧的 episode」，
 * 而不是 feed 里的下一部剧；feed 只负责决定从哪部剧开始。
 */
export default function Player({ items, index, startAt = 0, startEpOffset = 0, onClose }) {
  const item = items[index];
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [episodes, setEpisodes] = useState([]);
  const [epIndex, setEpIndex] = useState(0);
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [showEps, setShowEps] = useState(false);
  const activeEpRef = useRef(null);
  const closingRef = useRef(false);
  // 只对“从预览点进来的那一集”生效一次；后续切集/重试都从 0 开始。
  const initialRef = useRef({ vid: item.vid, at: Math.max(0, Number(startAt) || 0), index: null, used: false });

  const close = () => {
    closingRef.current = true;
    // 仍在第 1 集(= 预览那一集)时，把当前进度带回去，让竖滑预览接着同一位置。
    const v = videoRef.current;
    const ep1Time = (ep?.vid === item.vid && v && Number.isFinite(v.currentTime)) ? v.currentTime : null;
    onClose(ep1Time);
  };

  // 打开某部剧：拉剧集列表；feed 的 vid 通常是第 1 集，命中就定位到它。
  useEffect(() => {
    let cancelled = false;
    initialRef.current = {
      vid: item.vid,
      at: Math.max(0, Number(startAt) || 0),
      index: null,
      used: false,
    };
    setEpisodes([]);
    setEpIndex(0);
    setMeta(null);
    setStatus('loading');
    setMessage('');

    (async () => {
      try {
        if (!api.episodes) throw new Error('当前版本不支持剧集列表');
        const r = await api.episodes(item.series_id);
        if (cancelled) return;
        const list = (r.episodes || []).filter((e) => e.vid);
        if (!list.length) throw new Error('该剧没有可播放剧集');
        setMeta(r);
        setEpisodes(list);
        const base = list.findIndex((e) => e.vid === item.vid);
        const hit = base >= 0 ? base : 0;
        // startEpOffset：预览播完进来时 +1，从下一集开始（越界则停在最后一集）。
        const idx = Math.min(list.length - 1, Math.max(0, hit + (Number(startEpOffset) || 0)));
        initialRef.current.index = idx;
        setEpIndex(idx);
      } catch (e) {
        if (cancelled) return;
        // 降级：至少把 feed 里的第 1 集播了，不让整个播放器打不开。
        setEpisodes(item.vid ? [{ index: 1, vid: item.vid, title: item.title }] : []);
        setEpIndex(0);
        setMessage(clean(e));
      }
    })();

    return () => { cancelled = true; };
  }, [item.series_id, item.vid, startAt, startEpOffset]);

  const ep = episodes[epIndex];
  const total = episodes.length || meta?.episode_cnt || item.episode_cnt || 0;
  const hasPrev = epIndex > 0;
  const hasNext = epIndex < episodes.length - 1;

  const goNext = () => { initialRef.current.used = true; if (hasNext) setEpIndex((i) => i + 1); };
  const goPrev = () => { initialRef.current.used = true; if (hasPrev) setEpIndex((i) => i - 1); };
  const chooseEp = (i) => {
    initialRef.current.used = true;
    setEpIndex(i);
    setShowEps(false);
  };

  // 打开选集面板时，把当前集滚到可见位置。
  useEffect(() => {
    if (showEps) {
      requestAnimationFrame(() => activeEpRef.current?.scrollIntoView({ block: 'nearest' }));
    }
  }, [showEps, epIndex]);

  // 当前集变化：180ms 防抖后 prepare；快速连点“下一集”只启动最后停留的那一集。
  useEffect(() => {
    if (!ep?.vid) return undefined;
    let cancelled = false;
    setStatus('loading');
    setMessage('');

    const timer = setTimeout(async () => {
      try {
        const info = await api.prepare(ep.vid);
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;

        if (hlsRef.current) { hlsRef.current(); hlsRef.current = null; }
        const init = initialRef.current;
        let startPosition = 0;
        if (!init.used && init.index === epIndex && init.vid === ep.vid) {
          startPosition = init.at;
          init.used = true;
        }
        hlsRef.current = playHls(video, info.hlsUrl, {
          startPosition,
          onReady: () => { if (!cancelled) setStatus('ready'); },
          onError: (msg) => { if (!cancelled) { setStatus('error'); setMessage(msg); } },
        });

        // 当前集起播后再预取下一集，切集更快，且不抢当前集的转码 slot。
        const next = episodes[epIndex + 1];
        if (next?.vid) api.prepare(next.vid).catch(() => {});
      } catch (e) {
        if (!cancelled) {
          setStatus('error');
          setMessage(clean(e));
        }
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (hlsRef.current) { hlsRef.current(); hlsRef.current = null; }
      // 从预览点进来的第 1 集，关闭播放器时不要 cancel：
      // 预览还要接着用同一份 HLS；其它集正常取消，释放转码 slot。
      if (!(closingRef.current && ep.vid === item.vid)) {
        api.cancel(ep.vid).catch(() => {});
      }
    };
  }, [ep?.vid, epIndex, episodes, attempt]);

  // 键盘：Esc 关闭，←/→ 切同一部剧的上一集/下一集
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (showEps) setShowEps(false);
        else close();
      } else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="player-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="player">
        <header className="player-head">
          <div className="player-title">
            {item.title}
            <span className="player-ep">
              {total ? `第 ${epIndex + 1}/${total} 集` : ''}
            </span>
          </div>
          <div className="player-head-actions">
            <button className="iconbtn" onClick={close} title="关闭 (Esc)">✕</button>
          </div>
        </header>

        {showEps && (
          <aside className="episode-panel" onClick={(e) => e.stopPropagation()}>
            <div className="episode-panel-head">
              <div>
                选集
                <span className="episode-panel-count">
                  {episodes.length ? `${episodes.length} 集` : '暂无剧集'}
                </span>
              </div>
              <button className="iconbtn" onClick={() => setShowEps(false)} title="关闭选集">✕</button>
            </div>
            <div className="episode-grid">
              {episodes.map((e, i) => (
                <button
                  key={e.vid}
                  ref={i === epIndex ? activeEpRef : null}
                  className={`episode-btn ${i === epIndex ? 'active' : ''}`}
                  onClick={() => chooseEp(i)}
                  title={e.title || `第 ${e.index || i + 1} 集`}
                >
                  {e.index || i + 1}
                </button>
              ))}
            </div>
          </aside>
        )}

        <div className="player-stage">
          <video ref={videoRef} controls autoPlay playsInline onEnded={goNext} />
          {status === 'loading' && <div className="player-mask">准备 1080p…</div>}
          {status === 'error' && (
            <div className="player-mask error">
              <div>播放失败</div>
              <div className="small">{message}</div>
              <div className="mask-actions">
                <button onClick={() => setAttempt((a) => a + 1)}>重试</button>
                {hasNext && <button onClick={goNext}>跳过本集 →</button>}
              </div>
            </div>
          )}
        </div>

        <footer className="player-foot">
          <button disabled={!hasPrev} onClick={goPrev}>← 上一集</button>
          <button disabled={!hasNext} onClick={goNext}>下一集 →</button>
          <button
            className={`episode-fab ${showEps ? 'active' : ''}`}
            onClick={() => setShowEps((v) => !v)}
            title="选集"
            aria-expanded={showEps}
          >
            <span className="episode-fab-icon">▦</span>
            选集
          </button>
        </footer>
      </div>
    </div>
  );
}
