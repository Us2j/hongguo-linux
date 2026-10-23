import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import SearchBar from './components/SearchBar.jsx';
import CardGrid from './components/CardGrid.jsx';
import Reels from './components/Reels.jsx';
import Player from './components/Player.jsx';

const api = window.api;

// 分类频道。genre 对应 landpage 的 req_scene + select_items.genre。
const CATEGORIES = [
  { key: 'short', label: '真人剧', genre: 'short_play' },
  { key: 'manhua', label: '漫剧', genre: 'comic_series' },
  { key: 'ai', label: 'AI短剧', genre: 'ai_series' },
];
const DEFAULT_CAT = 'manhua'; // 默认漫剧

function initialMode() {
  try { return localStorage.getItem('hg.mode') === 'device' ? 'device' : 'guest'; } catch { return 'guest'; }
}

export default function App() {
  const [view, setView] = useState('reels'); // 'reels' | 'category' | 'search'
  const [mode, setMode] = useState(initialMode); // 'guest' | 'device'
  const [cat, setCat] = useState(DEFAULT_CAT);

  // feed（竖滑 + 分类 共用同一份 genre feed）；search 独立。两套互不覆盖。
  const [feedItems, setFeedItems] = useState([]);
  const [feedPage, setFeedPage] = useState(0);
  const [feedHasMore, setFeedHasMore] = useState(true);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState('');

  const [searchItems, setSearchItems] = useState([]);
  const [searchPage, setSearchPage] = useState(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');

  const [query, setQuery] = useState('');
  const [playIndex, setPlayIndex] = useState(-1);
  const [playStart, setPlayStart] = useState(0);
  const [playEpOffset, setPlayEpOffset] = useState(0);
  const [playList, setPlayList] = useState('feed'); // 播放器取哪份数组：'feed' | 'search'
  const [identities, setIdentities] = useState([]);

  const genreOf = (key) => CATEGORIES.find((c) => c.key === key)?.genre ?? null;

  // 各自的加载令牌：并发/快速切换时只认最后一次，丢弃被取代的旧响应（防串、防旧错打扰）。
  const feedSeq = useRef(0);
  const searchSeq = useRef(0);
  // 预览第 1 集的共享播放位置：播放器关闭回写、竖滑恢复 seek，保证两边进度一致。
  const previewAtRef = useRef({ vid: null, t: 0 });

  const loadFeed = useCallback(async (p, genre) => {
    const seq = ++feedSeq.current;
    setFeedLoading(true);
    setFeedError('');
    try {
      const res = await api.feed(p, genre);
      if (seq !== feedSeq.current) return;
      const list = res?.items || [];
      setFeedItems((prev) => (p > 0 ? [...prev, ...list] : list));
      setFeedHasMore(!!res?.hasMore);
    } catch (e) {
      if (seq !== feedSeq.current) return;
      setFeedError(e?.message || String(e));
    } finally {
      if (seq === feedSeq.current) setFeedLoading(false);
    }
  }, []);

  const loadSearch = useCallback(async (p, q) => {
    const seq = ++searchSeq.current;
    setSearchLoading(true);
    setSearchError('');
    try {
      const res = mode === 'guest' ? await api.webSearch(q) : await api.search(q, p);
      if (seq !== searchSeq.current) return;
      const list = res?.items || [];
      setSearchItems((prev) => (p > 0 ? [...prev, ...list] : list));
      setSearchHasMore(!!res?.hasMore);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setSearchError(e?.message || String(e));
    } finally {
      if (seq === searchSeq.current) setSearchLoading(false);
    }
  }, [mode]);

  // 只在进入软件时加载一次 feed（默认分类）。切 tab 不重载。
  useEffect(() => { loadFeed(0, genreOf(DEFAULT_CAT)); }, [loadFeed]);

  // 切模式：持久化；若正停在搜索结果上，用新后端重搜（feed 免签、与模式无关，不动）。
  const changeMode = (m) => {
    if (m === mode || (m !== 'guest' && m !== 'device')) return;
    setMode(m);
    try { localStorage.setItem('hg.mode', m); } catch { /* ignore */ }
  };
  useEffect(() => {
    if (view === 'search' && query) {
      setSearchItems([]); setSearchPage(0); setSearchHasMore(false);
      loadSearch(0, query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // 进入游客模式就预热网页搜索隐藏窗，首次搜索更快。
  useEffect(() => {
    if (mode === 'guest') { try { api.prewarmWebSearch?.(); } catch { /* ignore */ } }
  }, [mode]);

  // 身份列表 + 应用内热切换（仅设备模式用到）
  const refreshIdentities = useCallback(async () => {
    if (!api.listIdentities) return;
    try { const r = await api.listIdentities(); setIdentities(r.identities || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { refreshIdentities(); }, [refreshIdentities]);

  const useIdentity = async (name) => {
    if (!api.useIdentity) return;
    try {
      await api.useIdentity(name);        // 切 device.json + 主进程 reloadDevice
      await refreshIdentities();
      // 仅影响签名搜索；在搜索页就用新身份重搜，feed 不动。
      if (view === 'search' && query) {
        setSearchItems([]); setSearchPage(0); setSearchHasMore(false);
        loadSearch(0, query);
      }
    } catch (e) {
      setSearchError(e?.message || String(e));
    }
  };

  // 切 tab：只换 view，不 reset、不重载（竖滑常驻挂载保留位置；feed/search 都保留）。
  const switchView = (v) => { if (v !== view) setView(v); };

  // 换分类 = 换内容：reset feed 并重载；Reels 因 key 变化重挂载回到顶部。
  const switchCat = (key) => {
    if (key === cat) return;
    setCat(key);
    setFeedItems([]); setFeedPage(0); setFeedHasMore(true);
    loadFeed(0, genreOf(key));
  };

  const openPlayer = (i, startAt = 0, epOffset = 0, list = 'feed') => {
    setPlayStart(Math.max(0, Number(startAt) || 0));
    setPlayEpOffset(Number(epOffset) || 0);
    setPlayList(list === 'search' ? 'search' : 'feed');
    setPlayIndex(i);
  };

  const doSearch = (q) => {
    if (!q) return;
    setQuery(q);
    setView('search');
    setSearchItems([]); setSearchPage(0); setSearchHasMore(false);
    loadSearch(0, q);
  };

  const loadMore = () => {
    if (view === 'search') {
      if (searchLoading || !searchHasMore) return;
      const np = searchPage + 1; setSearchPage(np); loadSearch(np, query);
    } else {
      if (feedLoading || !feedHasMore) return;
      const np = feedPage + 1; setFeedPage(np); loadFeed(np, genreOf(cat));
    }
  };

  const error = view === 'search' ? searchError : feedError;
  const playItems = playList === 'search' ? searchItems : feedItems;

  return (
    <div className="app">
      <Sidebar
        view={view}
        onSwitch={switchView}
        mode={mode}
        onMode={changeMode}
        identities={identities}
        onUseIdentity={useIdentity}
      />
      <main className={`content ${view === 'reels' ? 'content-reels' : ''}`}>
        {view === 'search' && (
          <SearchBar onSearch={doSearch} mode={mode} />
        )}
        {(view === 'reels' || view === 'category') && (
          <div className="cat-tabs">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                className={`cat-tab ${cat === c.key ? 'active' : ''}`}
                onClick={() => switchCat(c.key)}
              >{c.label}</button>
            ))}
          </div>
        )}
        {error && <div className="banner error">加载失败：{error}</div>}

        {/* 竖滑常驻挂载：切走只隐藏、不卸载，保留 scroll/active/预览视频 */}
        <Reels
          key={`reels-${cat}`}
          hidden={view !== 'reels'}
          items={feedItems}
          loading={feedLoading}
          hasMore={feedHasMore}
          onMore={loadMore}
          onOpen={(i, s, o) => openPlayer(i, s, o, 'feed')}
          paused={view !== 'reels' || playIndex >= 0}
          previewAtRef={previewAtRef}
        />

        {view === 'category' && (
          <CardGrid
            items={feedItems}
            loading={feedLoading}
            hasMore={feedHasMore}
            onMore={loadMore}
            onOpen={(i) => openPlayer(i, 0, 0, 'feed')}
          />
        )}
        {view === 'search' && (
          <CardGrid
            items={searchItems}
            loading={searchLoading}
            hasMore={searchHasMore}
            onMore={loadMore}
            onOpen={(i) => openPlayer(i, 0, 0, 'search')}
          />
        )}
      </main>

      {playIndex >= 0 && playItems[playIndex] && (
        <Player
          items={playItems}
          index={playIndex}
          startAt={playStart}
          startEpOffset={playEpOffset}
          onClose={(ep1Time) => {
            if (ep1Time != null && playItems[playIndex]) {
              previewAtRef.current = { vid: playItems[playIndex].vid, t: ep1Time };
            }
            setPlayIndex(-1); setPlayStart(0); setPlayEpOffset(0);
          }}
        />
      )}
    </div>
  );
}
