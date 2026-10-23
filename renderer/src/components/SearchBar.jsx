import React, { useState } from 'react';

export default function SearchBar({ onSearch, mode = 'guest' }) {
  const [q, setQ] = useState(''); // 每次进入搜索页从空开始，不预填上次关键字
  const guest = mode === 'guest';

  const submit = (e) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    onSearch(v);
    setQ(''); // 提交后清空输入框
  };

  return (
    <form className="searchbar" onSubmit={submit}>
      <input
        type="text"
        value={q}
        placeholder={guest ? '网页搜短剧，回车确认（游客）' : '站内搜索短剧，回车确认（设备）'}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
      />
      <button type="submit">{guest ? '网页搜索' : '站内搜索'}</button>
    </form>
  );
}
