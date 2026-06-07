import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { T, btn, btnClass, stateMeta } from './ui.js';
import LogDrawer from './LogDrawer.jsx';
import PluginList from './PluginList.jsx';

const bridge = window.ggbx || makeMockBridge();
const GITHUB_URL = 'https://github.com/tangxiaoyi97/ngb-loader';

function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1920 1920" aria-hidden="true">
      <g stroke="#9aa0c8" strokeWidth="62" strokeLinecap="round">
        <line x1="920" y1="1000" x2="912" y2="365" /><line x1="920" y1="1000" x2="278" y2="826" />
        <line x1="920" y1="1000" x2="1651" y2="730" /><line x1="920" y1="1000" x2="500" y2="1555" />
        <line x1="920" y1="1000" x2="1382" y2="1498" />
      </g>
      <g fill="#7d7df3">
        <circle cx="912" cy="365" r="155" /><circle cx="278" cy="826" r="155" />
        <circle cx="1651" cy="730" r="155" /><circle cx="500" cy="1555" r="155" />
        <circle cx="1382" cy="1498" r="155" />
      </g>
      <circle cx="920" cy="1000" r="185" fill={T.purple} />
    </svg>
  );
}

function App() {
  const [entries, setEntries] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [settings, setSettings] = useState({});
  const [plugins, setPlugins] = useState([]);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logOpen, setLogOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [view, setView] = useState('home');
  const isMock = !window.ggbx;

  const loadPlugins = useCallback(async (id) => {
    if (!id) { setPlugins([]); return; }
    const pl = await bridge.listPlugins(id);
    if (pl.ok) setPlugins(pl.data);
  }, []);

  const refresh = useCallback(async () => {
    const r = await bridge.list();
    if (r.ok) {
      setEntries(r.data);
      setSelectedId((cur) => (cur && r.data.some((e) => e.id === cur)) ? cur : (r.data[0] && r.data[0].id) || null);
    }
    const s = await bridge.getSettings();
    if (s.ok) setSettings(s.data);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadPlugins(selectedId); }, [selectedId, loadPlugins]);
  useEffect(() => bridge.onLog((e) => setLogs((l) => [...l, e])), []);

  const flash = (msg, kind = 'info') => { setToast({ msg, kind }); setTimeout(() => setToast(null), 3000); };
  const selected = entries.find((e) => e.id === selectedId) || null;

  async function addGgb() {
    const picked = await bridge.pickApp();
    if (!picked.ok || !picked.data) return;
    const r = await bridge.add(picked.data);
    if (!r.ok) return flash(r.error || 'Failed to add', 'error');
    flash(r.data.created ? 'GeoGebra added' : 'Already in the list');
    if (r.data.entry && r.data.entry.id) setSelectedId(r.data.entry.id);
    setView('home');
    refresh();
  }
  async function chooseBackup() {
    const picked = await bridge.pickFolder();
    if (!picked.ok || !picked.data) return;
    const r = await bridge.setSettings({ defaultBackupDir: picked.data });
    if (r.ok) { setSettings(r.data); flash('Backup folder updated'); }
  }
  async function runOp(op) {
    if (!selected) return;
    setBusy(true); setLogs([]);
    // open the OS terminal to follow the live log (the in-app drawer stays as a fallback)
    bridge.openTerminal && bridge.openTerminal();
    const r = op === 'inject' ? await bridge.inject(selected.id) : await bridge.restore(selected.id);
    setBusy(false);
    flash(r.ok ? (op === 'inject' ? 'Injection complete' : 'Restored') : `${op === 'inject' ? 'Injection' : 'Restore'} failed: ${r.error || ''}`, r.ok ? 'ok' : 'error');
    refresh();
  }
  async function launch(debug) {
    if (!selected) return;
    const r = await bridge.launch(selected.id, { debug });
    flash(r.ok ? (debug ? 'Launched in debug mode' : 'GeoGebra launched') : `Launch failed: ${r.error || ''}`, r.ok ? 'ok' : 'error');
  }
  async function removeGgb() {
    if (!selected) return;
    const r = await bridge.remove(selected.id, { restoreFirst: false });
    if (r.ok) { flash('Removed from list'); setSelectedId(null); refresh(); }
  }
  async function addPlugin() {
    const r = await bridge.addPlugin();
    if (!r.ok) return flash(r.error || 'Could not add plugin', 'error');
    if (r.data && r.data.canceled) return;
    flash(`Added “${(r.data.installed && r.data.installed.name) || 'plugin'}”`, 'ok');
    loadPlugins(selectedId);
  }
  async function togglePlugin(pluginId, enabled) {
    if (!selectedId) return;
    setPlugins((ps) => ps.map((p) => (p.id === pluginId ? { ...p, enabled } : p)));
    const r = await bridge.setPlugin(selectedId, pluginId, enabled);
    if (!r.ok) { flash('Could not save', 'error'); loadPlugins(selectedId); }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: T.bg }}>
      <div style={{ height: 26, WebkitAppRegion: 'drag', flexShrink: 0 }} />

      <header style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '4px 20px 14px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
          <Logo size={26} />
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-.3px' }}>Neogebra</div>
          {isMock && <span style={{ fontSize: 11, color: T.dim }}>preview</span>}
        </div>
        <Switcher entries={entries} selected={selected} onSelect={(id) => { setSelectedId(id); setView('home'); }} onAdd={addGgb} onSettings={() => setView('settings')} />
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px', minHeight: 0 }}>
        <div key={view + (selected && selected.id)} className="nx-fade-in">
          {view === 'settings' ? (
            <SettingsView settings={settings} onChooseBackup={chooseBackup} onBack={() => setView('home')} />
          ) : !selected ? (
            <EmptyState onAdd={addGgb} hasEntries={entries.length > 0} />
          ) : (
            <Home
              entry={selected} busy={busy} plugins={plugins}
              onInject={() => runOp('inject')} onRestore={() => runOp('restore')}
              onLaunch={launch} onRemove={removeGgb} onTogglePlugin={togglePlugin}
              onAddPlugin={addPlugin}
              onOpenPluginsFolder={() => bridge.openPluginsFolder()} onRefreshPlugins={() => loadPlugins(selected.id)}
            />
          )}
        </div>
      </div>

      <LogDrawer open={logOpen} logs={logs} onClose={() => setLogOpen(false)} />
      {toast && <Toast toast={toast} />}
    </div>
  );
}

function Switcher({ entries, selected, onSelect, onAdd, onSettings }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const m = selected ? stateMeta(selected.live && selected.live.state) : null;

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <button className="nx-switcher" onClick={() => setOpen((v) => !v)}
        style={{ appearance: 'none', cursor: 'pointer', width: '100%', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 11, padding: '11px 16px', borderRadius: 13,
          background: T.surface, border: `1px solid ${open ? T.purple : T.borderStrong}`,
          boxShadow: open ? '0 0 0 3px rgba(101,87,211,.12)' : T.shadowCard, color: T.text,
          transition: 'border-color .15s, box-shadow .15s' }}>
        {selected ? (
          <>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: m.dot, flexShrink: 0 }} />
            <span style={{ minWidth: 0, flex: 1, textAlign: 'left', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selected.label}</span>
            <span style={{ fontSize: 11, color: m.fg, background: m.bg, padding: '3px 9px', borderRadius: 999, flexShrink: 0 }}>{m.label}</span>
          </>
        ) : (
          <span style={{ flex: 1, textAlign: 'left', fontSize: 14, color: T.dim }}>No GeoGebra selected</span>
        )}
        <span style={{ color: T.dim, fontSize: 11, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div className="nx-pop" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 30,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, boxShadow: T.shadowRaise, overflow: 'hidden', padding: 6 }}>
          {entries.length > 0 && <div style={{ fontSize: 11, color: T.dim, padding: '6px 11px 4px' }}>Your GeoGebra</div>}
          {entries.map((e) => {
            const em = stateMeta(e.live && e.live.state);
            const active = selected && e.id === selected.id;
            return (
              <button key={e.id} className="nx-opt" onClick={() => { onSelect(e.id); setOpen(false); }}
                style={{ appearance: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 11px', borderRadius: 10, border: 'none',
                  background: active ? T.purpleSoft : 'transparent', color: T.text }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: em.dot, flexShrink: 0 }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.label}</span>
                  <span style={{ display: 'block', fontSize: 11, color: T.sub }}>{em.label} · {(e.live && e.live.version) || e.version || '?'}</span>
                </span>
                {active && <span style={{ color: T.purple, fontSize: 13 }}>✓</span>}
              </button>
            );
          })}
          <div style={{ height: 1, background: T.border, margin: '6px 4px' }} />
          <button className="nx-opt" onClick={() => { setOpen(false); onAdd(); }} style={menuItemStyle(T.purple, 500)}>＋ Add GeoGebra…</button>
          <button className="nx-opt" onClick={() => { setOpen(false); onSettings(); }} style={menuItemStyle(T.text)}>⚙ Settings</button>
        </div>
      )}
    </div>
  );
}

function menuItemStyle(color, weight = 400) {
  return { appearance: 'none', cursor: 'pointer', width: '100%', textAlign: 'left', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 11px', borderRadius: 10, border: 'none', background: 'transparent', color, fontSize: 13, fontWeight: weight };
}

function Card({ children, style, className }) {
  return <div className={className} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: T.shadowCard, ...style }}>{children}</div>;
}

function Home({ entry, busy, plugins, onInject, onRestore, onLaunch, onRemove, onTogglePlugin, onAddPlugin, onOpenPluginsFolder, onRefreshPlugins }) {
  const live = entry.live || {};
  const injected = live.state === 'injected';
  const missing = live.state === 'missing';
  const m = stateMeta(live.state);
  const enabledCount = plugins.filter((p) => p.enabled).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 2 }}>
      <Card className="nx-card" style={{ padding: '20px 22px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: T.dim, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 500 }}>Current host</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-.4px' }}>{entry.label}</h1>
            <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 11px', borderRadius: 999, background: m.bg, color: m.fg }}>{m.label}</span>
          </div>
          <div style={{ fontSize: 12.5, color: T.dim, marginTop: 5 }}>{live.version || entry.version || '?'} · {live.kind || '?'} · <span style={{ wordBreak: 'break-all' }}>{entry.path}</span></div>
        </div>

        {missing ? (
          <div style={{ background: T.redSoft, color: T.red, padding: '12px 14px', borderRadius: 12, fontSize: 13, marginTop: 16 }}>
            ⚠ This path can’t be found — GeoGebra may have been moved or deleted.
            <div style={{ marginTop: 10 }}><button className={btnClass('danger')} style={btn('danger', 'sm')} onClick={onRemove}>Remove from list</button></div>
          </div>
        ) : injected ? (
          <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 9 }}>
            <button className={btnClass('primary')} style={btn('primary')} onClick={() => onLaunch(false)}>▶ Launch GeoGebra</button>
            <button className={btnClass('ghost')} style={btn()} onClick={() => onLaunch(true)} title="Launch and open DevTools">Launch (debug)</button>
            <div style={{ flex: 1 }} />
            <button className={btnClass('ghost')} style={btn()} disabled={busy} onClick={onRestore}>{busy ? 'Working…' : 'Restore'}</button>
            <button className={btnClass('danger')} style={btn('danger')} onClick={onRemove} title="Remove from list (keeps files)">Remove</button>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <div style={{ background: T.purpleSoft, borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, color: T.text }}>
                <b style={{ fontWeight: 700 }}>Plugin framework not installed.</b>
                <span style={{ color: T.sub }}> Inject to load plugins and open the panel with Right‑Shift. Originals are backed up first.</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={btnClass('primary')} style={btn('primary')} disabled={busy} onClick={onInject}>{busy ? 'Working…' : 'Inject framework'}</button>
                <button className={btnClass('danger')} style={btn('danger', 'sm')} onClick={onRemove}>Remove</button>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="nx-card" style={{ padding: '18px 22px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Plugins <span style={{ fontSize: 12, fontWeight: 400, color: T.dim }}>· {enabledCount}/{plugins.length} enabled</span></h3>
            <div style={{ fontSize: 12, color: T.sub, marginTop: 3 }}>Settings apply to <b style={{ color: T.text, fontWeight: 500 }}>{entry.label}</b> only (after restart)</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className={btnClass('ghost')} style={btn('ghost', 'sm')} onClick={onOpenPluginsFolder} title="Open the shared plugins folder">Open folder</button>
            <button className={btnClass('ghost')} style={btn('ghost', 'sm')} onClick={onRefreshPlugins}>Refresh</button>
            <button className={btnClass('primary')} style={btn('primary', 'sm')} onClick={onAddPlugin}>＋ Add plugin</button>
          </div>
        </div>
        {!injected && !missing && (
          <div style={{ fontSize: 12, color: T.amber, background: T.amberSoft, borderRadius: 10, padding: '8px 12px', marginBottom: 12 }}>
            Plugins load once this GeoGebra has the framework <b>injected and is restarted</b>.
          </div>
        )}
        <PluginList plugins={plugins} onToggle={onTogglePlugin} />
      </Card>
    </div>
  );
}

const OSS_DEPS = [
  ['Electron', 'desktop app runtime', 'MIT'],
  ['React', 'manager UI', 'MIT'],
  ['react-dom', 'React DOM renderer', 'MIT'],
  ['Svelte', 'plugin panel UI', 'MIT'],
  ['esbuild', 'JavaScript bundler', 'MIT'],
  ['esbuild-svelte', 'Svelte plugin for esbuild', 'MIT'],
  ['Express', 'installer HTTP server', 'MIT'],
  ['ws', 'installer WebSocket server', 'MIT'],
  ['fs-extra', 'filesystem helpers', 'MIT'],
  ['electron-builder', 'packaging / installers', 'MIT'],
  ['jsdom', 'test environment', 'MIT'],
];

function SettingsView({ settings, onChooseBackup, onBack }) {
  const [info, setInfo] = useState({ version: '', electron: '', node: '' });
  useEffect(() => { bridge.appInfo().then((r) => r.ok && setInfo(r.data)); }, []);
  const open = (url) => bridge.openExternal(url);

  return (
    <div style={{ paddingTop: 2, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button className={btnClass('ghost')} style={{ ...btn('ghost', 'sm'), alignSelf: 'flex-start' }} onClick={onBack}>← Back</button>

      <Card className="nx-card" style={{ padding: '20px 22px' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>Backup folder</h3>
        <div style={{ fontSize: 12, color: T.sub, marginBottom: 14 }}>Where restore points are saved (a per‑version subfolder per GeoGebra).</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 12, color: settings.defaultBackupDir ? T.text : T.dim, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 10, padding: '11px 13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {settings.defaultBackupDir || 'Using default'}
          </div>
          <button className={btnClass('ghost')} style={btn('ghost', 'sm')} onClick={onChooseBackup}>Change…</button>
        </div>
      </Card>

      <Card className="nx-card" style={{ padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <Logo size={34} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Neogebra Loader <span style={{ fontSize: 13, fontWeight: 400, color: T.dim }}>v{info.version || '—'}</span></div>
            <div style={{ fontSize: 12, color: T.sub }}>A plugin loader for GeoGebra · ngb-loader</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button className={btnClass('ghost')} style={btn('ghost', 'sm')} onClick={() => open(GITHUB_URL)}>★ GitHub repo</button>
          <button className={btnClass('ghost')} style={btn('ghost', 'sm')} onClick={() => open(GITHUB_URL + '/issues')}>Report an issue</button>
        </div>

        <Section title="Open-source acknowledgements">
          <div style={{ marginBottom: 6 }}>Neogebra Loader is built with these open-source projects. Thanks to their authors and communities:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {OSS_DEPS.map(([name, role, lic]) => (
              <li key={name} style={{ fontSize: 12, color: T.sub }}>
                <span style={{ color: T.text, fontWeight: 500 }}>{name}</span> — {role} <span style={{ color: T.dim }}>({lic})</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Author &amp; license">
          Created by 唐晓翼. Released under the MIT License.
        </Section>
        <Section title="GeoGebra notice">
          Neogebra is an <b>unofficial, third-party</b> tool and is not affiliated with or endorsed by GeoGebra. It is provided for <b>learning and personal use only</b>. Thanks to GeoGebra for its open Apps API. Plugins are made by their own authors — content from third-party plugins that is not authored by this project’s author is not our responsibility.
        </Section>
      </Card>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 5 }} dangerouslySetInnerHTML={{ __html: title }} />
      <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function EmptyState({ onAdd, hasEntries }) {
  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: T.shadowCard, padding: '56px 32px', textAlign: 'center', color: T.sub }}>
        <Logo size={48} />
        <h2 style={{ margin: '14px 0 6px', fontSize: 20, color: T.text, fontWeight: 700 }}>{hasEntries ? 'Select a GeoGebra' : 'Welcome to Neogebra'}</h2>
        <p style={{ margin: '0 0 18px', fontSize: 14 }}>{hasEntries ? 'Pick one from the switcher above.' : 'Add your GeoGebra to start installing the plugin framework.'}</p>
        {!hasEntries && <button className={btnClass('primary')} style={btn('primary')} onClick={onAdd}>＋ Add GeoGebra</button>}
      </div>
    </div>
  );
}

function Toast({ toast }) {
  const bg = toast.kind === 'error' ? T.red : toast.kind === 'ok' ? T.green : '#33363f';
  return <div className="nx-toast" style={{ position: 'fixed', bottom: 22, left: '50%', background: bg, color: '#fff', padding: '11px 20px', borderRadius: 999, fontSize: 13, fontWeight: 500, boxShadow: T.shadowRaise, zIndex: 70 }}>{toast.msg}</div>;
}

function makeMockBridge() {
  let entries = [
    { id: 'ggb-6-0-570-aa', label: 'GeoGebra Classic 6', path: '/Applications/GeoGebra Classic 6.app', version: '6.0.570', live: { state: 'injected', kind: 'folder', version: '6.0.570', exists: true } },
    { id: 'ggb-6-0-800-bb', label: 'GeoGebra (test)', path: '/Users/me/Desktop/GGB-Test.app', version: '6.0.800', live: { state: 'pristine', kind: 'asar', version: '6.0.800', exists: true } },
  ];
  let settings = { defaultBackupDir: '/Users/me/Documents/Neogebra Backups' };
  let plugins = [
    { id: 'panel-manager', name: 'Plugin Panel', version: '0.2.0', author: 'Neogebra', description: 'Built-in panel (toggle with Right-Shift), loaded with the framework.', enabled: true, builtin: true },
    { id: 'ggb-hello', name: 'Hello', version: '1.0.0', author: '唐晓翼', description: 'Greets on startup, reports versions, and offers a rainbow Hello + heart demo.', enabled: true, builtin: false },
  ];
  const ok = (data) => Promise.resolve({ ok: true, data });
  return {
    list: () => ok(entries), getSettings: () => ok(settings), setSettings: (p) => { settings = { ...settings, ...p }; return ok(settings); },
    listPlugins: () => ok(plugins), setPlugin: (g, id, en) => { const p = plugins.find((x) => x.id === id); if (p && !p.builtin) p.enabled = en; return ok(true); },
    add: () => ok({ created: true, entry: entries[0] }), remove: (id) => { entries = entries.filter((e) => e.id !== id); return ok(true); },
    inject: (id) => { entries = entries.map((e) => e.id === id ? { ...e, live: { ...e.live, state: 'injected' } } : e); return ok({ changed: true }); },
    restore: (id) => { entries = entries.map((e) => e.id === id ? { ...e, live: { ...e.live, state: 'pristine' } } : e); return ok({ changed: true }); },
    launch: () => ok({ launched: true }), openPluginsFolder: () => ok(true), openExternal: () => ok(true), appInfo: () => ok({ version: '1.0.0', electron: '31', node: '20' }),
    addPlugin: () => ok({ canceled: false, installed: { id: 'demo', name: 'Demo plugin' } }),
    openTerminal: () => ok({ file: '/tmp/neogebra.log' }),
    pickApp: () => ok('/Applications/GeoGebra Classic 6.app'), pickFolder: () => ok('/Users/me/Documents/Neogebra Backups'),
    onLog: () => () => {},
  };
}

createRoot(document.getElementById('root')).render(<App />);
