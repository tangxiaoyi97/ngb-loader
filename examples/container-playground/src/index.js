/**
 * container-playground — a developer playground for the Neogebra native-row
 * container API (ctx.ui.createNativeRow).
 *
 * What it demonstrates:
 *   - 'override' mode  : a fully custom panel that lives in the algebra list.
 *   - 'hybrid' mode    : keeps GeoGebra's native row chrome (marble + ⋯ menu);
 *                        the marble click is routed to the plugin (onMarbleClick).
 *   - ctx.ui.theme()   : styling that matches GeoGebra and follows its theme.
 *
 * Open the settings popup (panel → this plugin → Open settings) to spawn
 * containers of each kind with content you type, and to remove them. Everything
 * here is PLUGIN code calling framework APIs — the framework knows nothing about
 * this plugin.
 */
import { Plugin } from '@neogebra/sdk';

let counter = 0;
const nextId = () => { counter += 1; return counter; };

export default class ContainerPlayground extends Plugin {
  async onLoad(ctx) {
    this.ctx = ctx;
    this.rows = [];        // { id, handle, mode }
    ctx.log.info('Container Playground loaded. Open its settings to spawn containers.');
  }

  async onEnable(ctx) {
    this.ctx = ctx;
    // Spawn one override container on enable so there's something to see.
    this.spawn('override', 'Hello from an override container 👋');
  }

  // ---- container management (uses the framework API) ----

  theme() {
    try { return (this.ctx.ui && this.ctx.ui.theme && this.ctx.ui.theme()) || null; }
    catch { return null; }
  }

  spawn(mode, text) {
    const ctx = this.ctx;
    if (!ctx.ui || typeof ctx.ui.createNativeRow !== 'function') {
      ctx.log.warn('host has no createNativeRow — update the framework');
      return null;
    }
    const id = nextId();
    // mode: 'override' | 'hybrid' (marble = expand) | 'switch' (marble = on/off toggle)
    const kind = mode === 'switch' ? 'hybrid' : mode;
    const label = text || (mode === 'switch' ? `Switch #${id}` : mode === 'hybrid' ? `Hybrid row #${id}` : `Container #${id}`);
    const entry = { id, mode, handle: null };
    const accent = (() => { try { const t = ctx.ui.theme && ctx.ui.theme(); return (t && t.primary) || '#6557D2'; } catch { return '#6557D2'; } })();

    const handle = ctx.ui.createNativeRow({
      name: `ngbPlayground${id}`,
      mode: kind,
      // hybrid/switch get the native GeoGebra ball; switch starts OFF (outline).
      marble: kind === 'hybrid' ? { kind: 'native', color: accent, filled: false } : undefined,
      onAttached: () => this.renderContainer(entry, label),
      onRemoved: () => { this.rows = this.rows.filter((r) => r !== entry); this.refreshSettings(); },
      onMarbleClick: (api) => {
        if (mode === 'switch') {
          // ON/OFF switch: flip the ball fill; the row text reflects state.
          const on = api.toggleFilled();
          entry.on = on;
          this.ctx.log.info(`switch #${entry.id} → ${on ? 'ON' : 'OFF'}`);
          this.renderContainer(entry);
        } else {
          api.toggle();          // hybrid: expand/collapse the row
        }
      },
      onExpandedChange: () => this.renderContainer(entry),
    });
    entry.handle = handle;
    this.rows.push(entry);
    if (handle.element) this.renderContainer(entry, label);
    this.refreshSettings();
    return entry;
  }

  renderContainer(entry, labelMaybe) {
    const el = entry.handle && entry.handle.element;
    if (!el) return;
    if (labelMaybe != null) entry.label = labelMaybe;
    const t = this.theme() || {};
    const accent = t.primary || '#6557D2';
    const soft = t.primaryVariant || '#F3F0FF';
    const text = t.text || 'rgb(28,28,31)';
    const font = t.fontFamily || 'system-ui, sans-serif';

    if (entry.mode === 'override') {
      // Full custom panel — we paint the whole thing.
      el.innerHTML = '';
      const box = document.createElement('div');
      box.style.cssText = `font-family:${font}; color:${text}; padding:8px 10px; border-left:3px solid ${accent}; background:${soft}; border-radius:6px; margin:2px 0; font-size:13px; display:flex; align-items:center; gap:8px; justify-content:space-between;`;
      const span = document.createElement('span');
      span.textContent = `[override] ${entry.label || ''}`;
      const btn = document.createElement('button');
      btn.textContent = 'ping';
      btn.style.cssText = `font:inherit; font-size:12px; cursor:pointer; border:1px solid ${accent}; color:#fff; background:${accent}; border-radius:6px; padding:3px 9px;`;
      btn.addEventListener('click', () => { span.textContent = `[override] pinged @ ${new Date().toLocaleTimeString()}`; });
      box.append(span, btn);
      el.appendChild(box);
    } else {
      // hybrid/switch: the FRAMEWORK draws the native ball in the marble slot and
      // routes its click; we only fill the text slot. (For 'switch' the ball's
      // fill is the on/off state, toggled in onMarbleClick.)
      el.innerHTML = '';
      const span = document.createElement('span');
      span.style.cssText = `font-family:${font}; color:${text}; font-size:14px;`;
      const expanded = entry.handle && entry.handle.isExpanded && entry.handle.isExpanded();
      span.textContent = entry.mode === 'switch'
        ? `${entry.label || 'Switch'} — ${entry.on ? 'ON' : 'OFF'}`
        : (entry.label || 'Hybrid row') + (expanded ? ' (expanded)' : '');
      el.appendChild(span);
    }
  }

  removeRow(entry) {
    try { entry.handle && entry.handle.destroy(); } catch { /* ignore */ }
    this.rows = this.rows.filter((r) => r !== entry);
    this.refreshSettings();
  }

  // ---- settings popup (the control panel for the playground) ----

  onOpenSettings(ctx) {
    this.ctx = ctx;
    this.openSettings();
  }

  openSettings() {
    if (typeof document === 'undefined') return;
    this.removeSettingsOverlay();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial; position:fixed; inset:0; z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    this._settingsHost = host;
    this._settingsShadow = shadow;
    this.refreshSettings();
  }

  removeSettingsOverlay() {
    if (this._settingsHost && this._settingsHost.remove) this._settingsHost.remove();
    this._settingsHost = null;
    this._settingsShadow = null;
  }

  refreshSettings() {
    const shadow = this._settingsShadow;
    if (!shadow) return;
    const t = this.theme() || {};
    const accent = t.primary || '#6557D2';
    const soft = t.primaryVariant || '#F3F0FF';
    const text = t.text || 'rgb(28,28,31)';
    const font = t.fontFamily || 'system-ui, sans-serif';

    shadow.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      .scrim { position:fixed; inset:0; background:rgba(17,19,27,.46); backdrop-filter:blur(3px); display:grid; place-items:center; }
      .modal { width:min(460px, calc(100vw - 28px)); background:#fff; color:${text}; font-family:${font}; border-radius:14px; box-shadow:0 24px 64px rgba(30,40,90,.3); overflow:hidden; }
      header { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; border-bottom:1px solid #e3e6ee; }
      h2 { margin:0; font-size:15px; }
      .x { all:unset; cursor:pointer; font-size:18px; color:#5b616e; padding:2px 8px; border-radius:8px; }
      .x:hover { background:#eef1f6; }
      .body { padding:14px 16px; display:flex; flex-direction:column; gap:12px; }
      .row { display:flex; gap:8px; align-items:center; }
      input { flex:1; box-sizing:border-box; border:1px solid #e3e6ee; border-radius:8px; padding:8px 9px; font:inherit; font-size:13px; outline:none; }
      input:focus { border-color:${accent}; box-shadow:0 0 0 2px ${soft}; }
      .btn { all:unset; cursor:pointer; font-size:13px; padding:8px 12px; border-radius:8px; background:${accent}; color:#fff; text-align:center; }
      .btn.alt { background:${soft}; color:${accent}; }
      .btn:hover { filter:brightness(1.05); }
      .hint { color:#5b616e; font-size:11.5px; line-height:1.5; }
      .list { display:flex; flex-direction:column; gap:6px; max-height:200px; overflow:auto; }
      .item { display:flex; align-items:center; gap:8px; justify-content:space-between; border:1px solid #e3e6ee; border-radius:8px; padding:7px 9px; font-size:12.5px; }
      .tag { font-size:10.5px; padding:1px 7px; border-radius:10px; background:${soft}; color:${accent}; }
      .del { all:unset; cursor:pointer; color:#d93025; font-size:12px; padding:2px 8px; border-radius:6px; }
      .del:hover { background:#fde8e6; }
      .empty { color:#9097a5; font-size:12px; text-align:center; padding:8px; }
      .sect { font-size:12px; font-weight:600; color:${text}; }
    `;
    shadow.appendChild(style);

    const h = (tag, attrs = {}, kids = []) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
      for (const kid of [].concat(kids)) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
      return n;
    };

    const input = h('input', { type: 'text', placeholder: 'Container content text…' });
    const addOverride = h('button', { class: 'btn', text: '+ override' });
    addOverride.addEventListener('click', () => { this.spawn('override', input.value.trim() || undefined); });
    const addHybrid = h('button', { class: 'btn alt', text: '+ hybrid' });
    addHybrid.addEventListener('click', () => { this.spawn('hybrid', input.value.trim() || undefined); });
    const addSwitch = h('button', { class: 'btn alt', text: '+ switch' });
    addSwitch.addEventListener('click', () => { this.spawn('switch', input.value.trim() || undefined); });

    const list = h('div', { class: 'list' });
    if (!this.rows.length) list.append(h('div', { class: 'empty', text: 'No containers yet — add one above.' }));
    for (const entry of this.rows) {
      const item = h('div', { class: 'item' });
      const left = h('span', {}, [h('span', { class: 'tag', text: entry.mode }), ` #${entry.id} ${entry.label ? `· ${entry.label}` : ''}`]);
      const del = h('button', { class: 'del', text: 'remove' });
      del.addEventListener('click', () => this.removeRow(entry));
      item.append(left, del);
      list.append(item);
    }

    const close = h('button', { class: 'x', text: '×' });
    close.addEventListener('click', () => this.removeSettingsOverlay());

    const modal = h('div', { class: 'modal' }, [
      h('header', {}, [h('h2', { text: 'Container Playground' }), close]),
      h('div', { class: 'body' }, [
        h('div', { class: 'hint', text: 'Spawn native-row containers and watch them appear in the algebra list. Override = fully custom; Hybrid = keeps the native dot + ⋯ menu (click the dot to toggle).' }),
        h('div', { class: 'row' }, [input]),
        h('div', { class: 'row' }, [addOverride, addHybrid, addSwitch]),
        h('div', { class: 'sect', text: `Active containers (${this.rows.length})` }),
        list,
      ]),
    ]);
    const scrim = h('div', { class: 'scrim' }, [modal]);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) this.removeSettingsOverlay(); });
    shadow.appendChild(scrim);
  }

  async onDisable() {
    for (const entry of this.rows.slice()) this.removeRow(entry);
    this.removeSettingsOverlay();
  }

  async onUnload() {
    this.removeSettingsOverlay();
  }
}
