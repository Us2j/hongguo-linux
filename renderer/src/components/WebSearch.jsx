import React, { useEffect, useRef, useState } from 'react';

const BASE = 'https://hongguoduanju.com/search';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function searchUrl(q) {
  const query = String(q || '').trim();
  return query ? `${BASE}/${encodeURIComponent(query)}` : BASE;
}

export default function WebSearch({ url, initialQuery = '', onSearch, onClose }) {
  const viewRef = useRef(null);
  const [q, setQ] = useState(initialQuery || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { setQ(initialQuery || ''); }, [initialQuery]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    try { v.loadURL(url || BASE); } catch { /* 初次挂载由 src 处理 */ }
  }, [url]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return undefined;
    const start = () => { setLoading(true); setError(''); };
    const stop = () => setLoading(false);
    const fail = (e) => {
      // -3 是主动取消/重定向，不当作失败。
      if (e?.errorCode === -3) return;
      setLoading(false);
      setError(`网页加载失败 (${e?.errorCode ?? '?'}) ${e?.errorDescription || ''}`);
    };
    v.addEventListener('did-start-loading', start);
    v.addEventListener('did-stop-loading', stop);
    v.addEventListener('did-fail-load', fail);
    return () => {
      v.removeEventListener('did-start-loading', start);
      v.removeEventListener('did-stop-loading', stop);
      v.removeEventListener('did-fail-load', fail);
    };
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const next = searchUrl(q);
    setError('');
    if (onSearch) onSearch(q);
    else { try { viewRef.current?.loadURL(next); } catch { /* noop */ } }
  };

  const back = () => { try { viewRef.current?.goBack(); } catch { /* noop */ } };
  const reload = () => { try { viewRef.current?.reload(); } catch { /* noop */ } };

  return (
    <section className="websearch">
      <div className="websearch-bar">
        <button type="button" className="websearch-close" onClick={onClose} title="关闭网页搜索">✕</button>
        <button type="button" className="websearch-nav" onClick={back} title="后退">←</button>
        <button type="button" className="websearch-nav" onClick={reload} title="刷新">⟳</button>
        <form className="websearch-form" onSubmit={submit}>
          <input
            type="text"
            value={q}
            placeholder="在红果官网搜索短剧"
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit">搜索</button>
        </form>
        {loading && <span className="websearch-state">加载中…</span>}
      </div>
      {error && <div className="websearch-error">{error}</div>}
      <webview
        ref={viewRef}
        className="websearch-view"
        src={url || BASE}
        partition="persist:hongguo-web"
        useragent={UA}
        allowpopups
      />
    </section>
  );
}
