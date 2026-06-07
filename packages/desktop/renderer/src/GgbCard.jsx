import React, { useState } from 'react';
import { T, btn, stateColor, stateLabel } from './ui.js';

/** One managed GeoGebra install: status, actions, and an expandable per-install plugin manager. */
export default function GgbCard({ entry, busy, bridge, onInject, onRestore, onRemove, onOpenBackup, onToast, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const live = entry.live || {};
  const injected = live.state === 'injected';
  const missing = live.state === 'missing';
  const color = stateColor(live.state);

  const pluginIds = Object.keys(entry.plugins || {});

  async function togglePlugin(pluginId, enabled) {
    const r = await bridge.setPlugin(entry.id, pluginId, enabled);
    if (!r.ok) onToast('插件状态保存失败', 'error');
    else onChanged();
  }

  async function launch(debug) {
    const r = await bridge.launch(entry.id, { debug });
    if (!r.ok) onToast('启动失败：' + (r.error || ''), 'error');
    else onToast(debug ? '已调试启动（自动开 DevTools）' : '已启动 GeoGebra', 'ok');
  }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16 }}>
        <div title={stateLabel(live.state)} style={{
          width: 10, height: 10, borderRadius: '50%', background: color,
          boxShadow: `0 0 10px ${color}`, flexShrink: 0,
        }} />

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.label}</span>
            <span style={{ fontSize: 12, color: T.sub }}>GeoGebra {live.version || entry.version || '?'}</span>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: 'rgba(255,255,255,0.06)', color }}>{stateLabel(live.state)}</span>
          </div>
          <div style={{ fontSize: 12, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 3 }}>{entry.path}</div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!missing && injected && (
            <>
              <button style={btn('primary')} onClick={() => launch(false)} title="启动这个 GeoGebra">启动</button>
              <button style={btn()} onClick={() => launch(true)} title="启动并自动打开 DevTools（排错用）">调试启动</button>
            </>
          )}
          {!missing && !injected && <button style={btn('primary')} disabled={busy} onClick={onInject}>{busy ? '处理中…' : '注入'}</button>}
          {!missing && injected && <button style={btn()} disabled={busy} onClick={onRestore}>{busy ? '处理中…' : '还原'}</button>}
          <button style={btn()} onClick={() => setExpanded((v) => !v)}>{expanded ? '收起' : '插件'}</button>
          <button style={btn('danger')} onClick={onRemove} title="从列表移除（不删除文件）">移除</button>
        </div>
      </div>

      {missing && (
        <div style={{ padding: '0 16px 14px', fontSize: 12, color: T.red }}>
          ⚠ 找不到该路径，可能 GeoGebra 被移动或删除了。
        </div>
      )}

      {expanded && (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: 16, background: 'rgba(0,0,0,0.18)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: T.sub }}>该 GeoGebra 的插件</span>
            <button style={{ ...btn(), padding: '5px 10px', fontSize: 12 }} onClick={onOpenBackup} disabled={!entry.backupDirResolved}>打开备份文件夹</button>
          </div>

          {pluginIds.length === 0 ? (
            <div style={{ fontSize: 12, color: T.dim, padding: '12px 0' }}>
              还没有为这个 GeoGebra 配置插件。把插件文件夹放入它的 GGB_Plugins 目录后，注入并启动 GeoGebra，按右 Shift 在面板里管理。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pluginIds.map((pid) => (
                <div key={pid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: T.card, borderRadius: 8 }}>
                  <span style={{ fontSize: 13 }}>{pid}</span>
                  <Switch on={entry.plugins[pid]} onChange={(v) => togglePlugin(pid, v)} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Switch({ on, onChange }) {
  return (
    <button
      role="switch" aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        appearance: 'none', border: 'none', cursor: 'pointer',
        width: 40, height: 24, borderRadius: 999, position: 'relative',
        background: on ? '#34c759' : 'rgba(255,255,255,0.16)',
        boxShadow: on ? '0 0 10px rgba(52,199,89,0.5)' : 'none',
        transition: 'background .2s',
      }}>
      <span style={{
        position: 'absolute', top: 3, left: on ? 19 : 3, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left .2s',
        boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}
