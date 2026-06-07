import React from 'react';
import { T } from './ui.js';

// Plugin icon: the manifest `icon` (resolved to a data URI) if present, else a
// purple square with the first two letters of the name.
export function PluginIcon({ icon, name, size = 44 }) {
  const radius = Math.round(size * 0.27);
  if (icon) {
    return (
      <img src={icon} alt="" width={size} height={size}
        style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', background: T.surfaceAlt, border: `1px solid ${T.border}` }} />
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: radius, display: 'grid', placeItems: 'center',
      background: T.purple, color: '#fff', fontWeight: 700, fontSize: Math.round(size * 0.34) }}>
      {(name || '?').trim().slice(0, 2).toUpperCase()}
    </div>
  );
}

/** The shared plugin library; toggling writes the per-GGB state.json the in-GeoGebra runtime reads. */
export default function PluginList({ plugins, onToggle }) {
  if (!plugins || plugins.length === 0) {
    return (
      <div style={{ color: T.sub, fontSize: 13, padding: '36px 16px', textAlign: 'center', background: T.surfaceAlt, borderRadius: 14 }}>
        <div style={{ fontSize: 30, marginBottom: 8 }}>🧩</div>
        No plugins yet.<br />
        <span style={{ fontSize: 12, color: T.dim }}>Click “Add plugin” and choose a plugin folder (with a manifest.json).</span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {plugins.map((p) => (
        <div key={p.id} style={{
          display: 'grid', gridTemplateColumns: '44px 1fr auto', gap: 14, alignItems: 'center',
          padding: '14px 16px', borderRadius: 14, background: T.surfaceAlt, border: `1px solid ${T.border}`,
          opacity: p.broken ? 0.7 : 1,
        }}>
          <PluginIcon icon={p.icon} name={p.name} size={44} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
              <span style={{ fontSize: 11, color: T.dim }}>v{p.version}</span>
              {p.builtin && <span style={{ fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 999, background: T.purpleSoft, color: T.purple }}>built-in</span>}
            </div>
            <div style={{ fontSize: 12, color: T.dim, marginTop: 2 }}>{p.author}</div>
            {p.description && <p style={{ margin: '6px 0 0', fontSize: 12.5, color: T.sub, lineHeight: 1.5 }}>{p.description}</p>}
            {p.error && <p style={{ margin: '6px 0 0', fontSize: 11.5, color: T.red }}>⚠ {p.error}</p>}
          </div>
          <Switch on={p.enabled} locked={p.builtin} onChange={(v) => !p.builtin && onToggle(p.id, v)}
            title={p.builtin ? 'Built-in plugin can’t be disabled' : (p.enabled ? 'Click to disable' : 'Click to enable')} />
        </div>
      ))}
    </div>
  );
}

function Switch({ on, locked, onChange, title }) {
  return (
    <button role="switch" aria-checked={on} title={title} disabled={locked} onClick={() => onChange(!on)}
      style={{
        appearance: 'none', border: 'none', cursor: locked ? 'default' : 'pointer',
        width: 44, height: 26, borderRadius: 999, position: 'relative', flexShrink: 0,
        background: on ? T.green : '#cdd1dc', opacity: locked ? 0.55 : 1,
        transition: 'background .2s', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.08)',
      }}>
      <span style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }} />
    </button>
  );
}
