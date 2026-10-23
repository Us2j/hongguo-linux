import React, { useEffect, useRef } from 'react';

function Card({ item, onOpen }) {
  return (
    <button className="card" onClick={onOpen} title={item.title}>
      <div className="thumb">
        {item.cover
          ? <img src={item.cover} alt="" loading="lazy" />
          : <div className="thumb-ph" />}
        {item.episode_cnt ? <span className="badge">{item.episode_cnt}集</span> : null}
      </div>
      <div className="meta">
        <div className="title">{item.title}</div>
        {item.category ? <div className="sub">{item.category}</div> : null}
      </div>
    </button>
  );
}

export default function CardGrid({ items, loading, hasMore, onMore, onOpen }) {
  const sentinel = useRef(null);

  // 滚动到底自动加载下一页
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loading) onMore();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onMore]);

  return (
    <div className="gridwrap">
      <div className="grid">
        {items.map((item, i) => (
          <Card key={item.series_id || i} item={item} onOpen={() => onOpen(i)} />
        ))}
      </div>
      {loading && <div className="hint">加载中…</div>}
      {!loading && items.length === 0 && <div className="hint">暂无内容</div>}
      <div ref={sentinel} className="sentinel" />
      {!hasMore && items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}
