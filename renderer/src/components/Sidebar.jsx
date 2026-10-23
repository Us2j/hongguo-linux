import React from 'react';

const TABS = [
  { key: 'reels', label: '竖滑', icon: '🎬' },
  { key: 'category', label: '分类', icon: '🗂️' },
  { key: 'search', label: '搜索', icon: '🔍' },
];

const MODES = [
  { key: 'guest', label: '游客', title: '游客：网页搜索 + 免登录播放，无需设备身份' },
  { key: 'device', label: '设备', title: '设备：签名站内搜索，需要设备身份(device ID)' },
];

export default function Sidebar({
  view, onSwitch, mode = 'guest', onMode, identities = [], onUseIdentity,
}) {
  return (
    <nav className="sidebar">
      <div className="brand">红果</div>
      {TABS.map((t) => (
        <button
          key={t.key}
          className={`navitem ${view === t.key ? 'active' : ''}`}
          onClick={() => onSwitch(t.key)}
        >
          <span className="icon">{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}

      <div className="sidebar-bottom">
        {/* 身份切换器只在设备模式出现 */}
        {mode === 'device' && identities.length > 0 && (
          <div className="identity-box">
            <div className="identity-title">身份</div>
            {identities.map((id) => (
              <button
                key={id.name}
                className={`identity-item ${id.active ? 'active' : ''}`}
                disabled={id.status !== 'ok' || id.active}
                title={`${id.source} · ${id.device_id} · ${id.status}`}
                onClick={() => onUseIdentity?.(id.name)}
              >
                <span className={`dot ${id.status}`} />
                <span className="identity-name">{id.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* 左下角模式开关：游客 / 设备 */}
        <div className="mode-switch" role="group" aria-label="模式">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={`mode-btn ${mode === m.key ? 'active' : ''}`}
              onClick={() => onMode?.(m.key)}
              title={m.title}
            >{m.label}</button>
          ))}
        </div>
      </div>
    </nav>
  );
}
