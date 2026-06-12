<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  /** Runtime bridge: listPlugins / enable / disable / openSettings / openPluginFolder. */
  export let runtime;
  export let open = false;
  export let view = 'plugins'; // 'plugins' | 'settings'
  export let theme = 'light';  // 'light' | 'dark' — follows GeoGebra
  /** Ask the host controller to close, so focus/pointer cleanup runs in one place. */
  export let requestClose = () => { open = false; };
  /** i18n (P3-5): provided by panel-manager from the host language. */
  export let t = (k) => k;
  /** Host font (P3-2): GeoGebra's own font family. */
  export let hostFont = '';
  /** Summon gestures (P3-3), persisted by panel-manager. */
  export let gestures = { rightShift: true, tripleCtrl: true };
  export let onGesturesChange = () => {};

  const APP_VERSION = '2.0.0-beta';
  const GITHUB_URL = 'https://github.com/tangxiaoyi97/ngb-loader';
  const DEPS = [
    ['Electron', 'desktop app runtime'],
    ['React', 'manager UI'],
    ['react-dom', 'React DOM renderer'],
    ['Svelte', 'plugin panel UI'],
    ['esbuild', 'JavaScript bundler'],
    ['esbuild-svelte', 'Svelte plugin for esbuild'],
    ['Express', 'installer HTTP server'],
    ['ws', 'installer WebSocket server'],
    ['fs-extra', 'filesystem helpers'],
    ['electron-builder', 'packaging / installers'],
    ['jsdom', 'test environment'],
  ];

  let plugins = [];
  let selectedId = null; // when set, show that plugin's detail page
  let isMock = runtime && runtime.isMock;
  // P1-2: low-key adaptation notice. When the DOM self-check failed, native
  // integrations are silently disabled — this one line (only visible after the
  // user deliberately opened the panel) is the only place that says so.
  let degraded = false;

  function refresh() {
    try { plugins = runtime.listPlugins() || []; } catch (e) { plugins = []; }
    try { degraded = !!(runtime.domHealth && runtime.domHealth().ok === false); } catch (e) { degraded = false; }
  }

  async function openSettings(p) {
    if (!p || !p.hasSettings) return;
    try { await runtime.openSettings(p.id); } catch (e) { /* ignore */ }
    // Issue B: hide the panel so only the plugin's settings UI remains.
    // Issue C: reset navigation first, so re-opening the panel lands on the
    // plugin list (not stuck on the detail page we just left).
    selectedId = null;
    view = 'plugins';
    requestClose();
  }

  function openFolder() { try { runtime.openPluginFolder && runtime.openPluginFolder(); } catch (e) {} }

  // Open links in the SYSTEM browser (an <a target=_blank> would spawn an
  // Electron window inside GeoGebra).
  function openLink(url) {
    try {
      if (runtime.openExternal) { runtime.openExternal(url); return; }
    } catch (e) { /* fall through */ }
    try { window.open(url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
  }

  // P3-3: gesture checkboxes — never let both go off (panel must stay reachable).
  function setGesture(key, value) {
    const next = { ...gestures, [key]: value };
    if (!next.rightShift && !next.tripleCtrl) { gestures = { ...gestures }; return; }
    gestures = next;
    try { onGesturesChange(next); } catch (e) { /* ignore */ }
  }

  $: footerHint = gestures.rightShift ? t('hintShift') : t('hintCtrl');

  // Network permissions for the selected plugin (declared hosts + this GGB's
  // recorded decisions). Loaded when the detail page opens.
  let netInfo = null;
  async function loadNet(id) {
    netInfo = null;
    try { netInfo = runtime.netPermissions ? await runtime.netPermissions(id) : null; } catch (e) { netInfo = null; }
  }
  // declared hosts ∪ hosts with a recorded decision (covers legacy records)
  $: netHosts = netInfo
    ? [...new Set([...(netInfo.declared || []), ...Object.keys(netInfo.approvals || {})])]
    : [];

  async function revokeHost(h) {
    try { runtime.revokeNetApproval && await runtime.revokeNetApproval(selectedId, h); } catch (e) { /* ignore */ }
    await loadNet(selectedId);
  }

  const select = (p) => { selectedId = p.id; loadNet(p.id); };
  const back = () => { selectedId = null; netInfo = null; };
  $: selected = plugins.find((p) => p.id === selectedId) || null;

  let lastOpen = false;
  $: if (open && !lastOpen) { lastOpen = true; selectedId = null; refresh(); }
  $: if (!open) lastOpen = false;
</script>

{#if open}
  <div class="bk {theme}" transition:fade={{ duration: 160 }} on:click={() => requestClose()} on:keydown role="button" tabindex="-1" aria-label="Close"></div>
  <div class="panel {theme}" style={hostFont ? `font-family:${hostFont}` : ''} transition:fly={{ x: 380, duration: 300, easing: cubicOut }} role="dialog" aria-label="Neogebra plugins">
    <header>
      <div class="brand">
        <svg class="logo" width="22" height="22" viewBox="0 0 1920 1920" aria-hidden="true">
          <g stroke="#9aa0c8" stroke-width="62" stroke-linecap="round">
            <line x1="920" y1="1000" x2="912" y2="365" /><line x1="920" y1="1000" x2="278" y2="826" />
            <line x1="920" y1="1000" x2="1651" y2="730" /><line x1="920" y1="1000" x2="500" y2="1555" />
            <line x1="920" y1="1000" x2="1382" y2="1498" />
          </g>
          <g fill="#7d7df3">
            <circle cx="912" cy="365" r="155" /><circle cx="278" cy="826" r="155" />
            <circle cx="1651" cy="730" r="155" /><circle cx="500" cy="1555" r="155" />
            <circle cx="1382" cy="1498" r="155" />
          </g>
          <circle cx="920" cy="1000" r="185" fill="#6557d3" />
        </svg>
        <div><h1>Neogebra</h1><span class="sub">{t('sub')} {isMock ? '· preview' : ''}</span></div>
      </div>
      <button class="icon" on:click={() => requestClose()} aria-label="Close">✕</button>
    </header>

    {#if !selected}
      <nav class="tabs">
        <button class:active={view === 'plugins'} on:click={() => (view = 'plugins')}>{t('tabPlugins')}</button>
        <button class:active={view === 'settings'} on:click={() => (view = 'settings')}>{t('tabAbout')}</button>
      </nav>
    {/if}

    <div class="body">
      {#if selected}
        <!-- plugin detail page — slides + fades in from the right -->
        <div class="page" in:fly|global={{ x: 30, duration: 280, easing: cubicOut }}>
          <button class="back" on:click={back} aria-label="Back to plugins">{t('back')}</button>
          <div class="detail">
            <div class="d-head">
              {#if selected.icon}
                <img class="icon-sq lg" class:broken={selected.error} src={selected.icon} alt="" />
              {:else}
                <div class="icon-sq lg" class:broken={selected.error}>{(selected.name || '?').trim().slice(0, 2).toUpperCase()}</div>
              {/if}
              <div class="d-title">
                <h2>{selected.name}</h2>
                <div class="d-meta">v{selected.version}{selected.author ? ` · ${selected.author}` : ''}</div>
                {#if selected.builtin}<span class="badge">{t('badgeBuiltin')}</span>{/if}
              </div>
            </div>
            {#if selected.error}<p class="err">⚠ {selected.error}</p>{/if}
            {#if selected.description}<p class="d-desc">{selected.description}</p>{/if}
            <button class="set wide" on:click={() => openSettings(selected)} disabled={!selected.hasSettings}>
              {selected.hasSettings ? t('openSettings') : t('noSettings')}
            </button>

            {#if netHosts.length > 0}
              <div class="net">
                <h4>{t('netTitle')}</h4>
                <ul class="net-list">
                  {#each netHosts as h (h)}
                    <li class="net-row">
                      <span class="net-host" title={h}>{h}</span>
                      {#if netInfo.approvals[h] === true}
                        <span class="net-state ok">{t('netApproved')}</span>
                        <button class="net-revoke" on:click={() => revokeHost(h)}>{t('netRevoke')}</button>
                      {:else if netInfo.approvals[h] === false}
                        <span class="net-state no">{t('netBlocked')}</span>
                        <button class="net-revoke" on:click={() => revokeHost(h)}>{t('netRevoke')}</button>
                      {:else}
                        <span class="net-state">{t('netNotAsked')}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
                <p class="net-note">{t('netNote')}</p>
              </div>
            {/if}
          </div>
        </div>
      {:else if view === 'plugins'}
        <div class="page" in:fly|global={{ x: -24, duration: 260, easing: cubicOut }}>
          <div class="toolbar">
            <span class="count">{plugins.length === 1 ? t('countOne') : t('countMany', plugins.length)}</span>
            <button class="ghost" on:click={refresh}>{t('refresh')}</button>
          </div>

          {#if degraded}
            <p class="adapt-note">{t('adaptNote')}</p>
          {/if}

          {#if plugins.length === 0}
            <div class="empty"><p>{t('emptyTitle')}</p><small>{t('emptyHint')}</small></div>
          {:else}
            <ul class="list">
              {#each plugins as p, i (p.id)}
                <li in:fly|global={{ y: 8, duration: 220, delay: 40 + i * 45, easing: cubicOut }}>
                  <button class="row" class:broken={p.error} on:click={() => select(p)}>
                    {#if p.icon}
                      <img class="icon-sq" src={p.icon} alt="" />
                    {:else}
                      <span class="icon-sq">{(p.name || '?').trim().slice(0, 2).toUpperCase()}</span>
                    {/if}
                    <span class="row-name">{p.name}</span>
                    {#if p.builtin}<span class="dot" title="built-in"></span>{/if}
                    <span class="row-ver">v{p.version}</span>
                    <span class="chev">›</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {:else}
        <div class="page about" in:fly|global={{ x: 22, duration: 240, easing: cubicOut }}>
          <div class="about-head">
            <span class="about-name">Neogebra Loader</span>
            <span class="about-ver">v{APP_VERSION}</span>
          </div>
          <p>{t('aboutDesc')}</p>

          <div class="gestures">
            <h4>{t('gestureTitle')}</h4>
            <label class="gest">
              <input type="checkbox" checked={gestures.rightShift} on:change={(e) => setGesture('rightShift', e.target.checked)} />
              {t('gestureRightShift')}
            </label>
            <label class="gest">
              <input type="checkbox" checked={gestures.tripleCtrl} on:change={(e) => setGesture('tripleCtrl', e.target.checked)} />
              {t('gestureTripleCtrl')}
            </label>
            <p class="gest-note">{t('gestureNote')}</p>
          </div>

          <button class="link" type="button" on:click={() => openLink(GITHUB_URL)}>★ GitHub repository</button>

          <div class="ack">
            <h4>Open-source acknowledgements</h4>
            <p>Neogebra Loader is built with these open-source projects (all MIT). Thanks to their authors and communities:</p>
            <ul class="ack-list">
              {#each DEPS as [name, role]}
                <li><span class="ack-name">{name}</span> — {role}</li>
              {/each}
            </ul>
            <h4>Author &amp; license</h4>
            <p>Created by 唐晓翼. Released under the MIT License.</p>
            <h4>GeoGebra notice</h4>
            <p>Neogebra is an unofficial, third-party tool and is not affiliated with or endorsed by GeoGebra. It is provided for learning and personal use. Thanks to GeoGebra for its open Apps API. Plugins are made by their own authors.</p>
          </div>
        </div>
      {/if}
    </div>

    <footer><span>v{APP_VERSION}</span><span class="hint">{footerHint}</span></footer>
  </div>
{/if}

<style>
  /* Brand: GeoGebra purple #6557d3 / blue #1565c0. */
  :host { all: initial; }
  .panel, .bk {
    --gx-accent: #6557d3; --gx-accent-soft: rgba(101,87,211,.12);
    /* Fallback only — the live host font is applied inline on the panel (P3-2). */
    font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
  }
  .panel.light {
    --gx-bg: #ffffff; --gx-fg: #27282b; --gx-sub: #5b616e; --gx-dim: #9097a5;
    --gx-border: #e3e6ee; --gx-fill: #f4f5f9; --gx-fill-hover: #eceef5; --gx-shadow: rgba(40,50,90,.18);
  }
  .panel.dark {
    --gx-bg: #2b2d31; --gx-fg: #ececf0; --gx-sub: #b7bcc7; --gx-dim: #8b909c;
    --gx-border: rgba(255,255,255,.10); --gx-fill: rgba(255,255,255,.05); --gx-fill-hover: rgba(255,255,255,.09); --gx-shadow: rgba(0,0,0,.45);
  }
  .bk { position: fixed; inset: 0; background: rgba(20,22,30,.22); }
  .bk.dark { background: rgba(0,0,0,.4); }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0;
    /* adaptive width: never narrower than 300, never wider than 360, ~30vw between */
    width: clamp(300px, 30vw, 360px);
    display: flex; flex-direction: column; font-size: 13px;
    background: var(--gx-bg); color: var(--gx-fg);
    border-left: 1px solid var(--gx-border); box-shadow: -16px 0 48px var(--gx-shadow);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 12px; }
  .brand { display: flex; align-items: center; gap: 11px; }
  .logo { display: block; flex-shrink: 0; }
  h1 { margin: 0; font-size: 15px; font-weight: 500; }
  .sub { font-size: 11px; color: var(--gx-sub); }
  .icon { all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--gx-sub); }
  .icon:hover { background: var(--gx-fill-hover); color: var(--gx-fg); }
  .tabs { display: flex; gap: 4px; margin: 0 14px 8px; padding: 4px; background: var(--gx-fill); border-radius: 9px; }
  .tabs button { all: unset; cursor: pointer; flex: 1; text-align: center; padding: 7px 0; border-radius: 6px; color: var(--gx-sub); font-weight: 500; font-family: inherit; }
  .tabs button.active { background: var(--gx-bg); color: var(--gx-accent); box-shadow: 0 1px 3px var(--gx-shadow); }
  .body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 14px 14px; position: relative; }
  .page { display: block; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; margin: 6px 2px 10px; }
  .adapt-note { font-size: 11.5px; line-height: 1.5; color: var(--gx-sub); margin: 0 2px 10px; opacity: .85; }
  .count { color: var(--gx-sub); font-size: 12px; }
  .ghost { all: unset; cursor: pointer; font-size: 12px; padding: 6px 11px; border-radius: 8px; color: var(--gx-sub); border: 1px solid var(--gx-border); margin-left: 6px; font-family: inherit; }
  .ghost:hover { background: var(--gx-fill-hover); }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .row { all: unset; box-sizing: border-box; cursor: pointer; width: 100%; display: flex; align-items: center; gap: 11px; padding: 9px 11px; border-radius: 10px; background: var(--gx-fill); border: 1px solid var(--gx-border); font-family: inherit; transition: background .12s, border-color .12s; }
  .row:hover { background: var(--gx-fill-hover); border-color: var(--gx-accent-soft); }
  .row.broken { opacity: .7; }
  .icon-sq { width: 30px; height: 30px; flex-shrink: 0; border-radius: 8px; display: grid; place-items: center; background: var(--gx-accent); color: #fff; font-weight: 700; font-size: 12px; }
  img.icon-sq { object-fit: cover; background: var(--gx-fill); border: 1px solid var(--gx-border); }
  .row-name { font-weight: 500; font-size: 13px; color: var(--gx-fg); min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gx-accent); flex-shrink: 0; }
  .row-ver { font-size: 11px; color: var(--gx-dim); flex-shrink: 0; }
  .chev { color: var(--gx-dim); font-size: 15px; flex-shrink: 0; margin-left: 1px; }
  .badge { font-size: 10px; padding: 1px 7px; border-radius: 10px; background: var(--gx-accent-soft); color: var(--gx-accent); white-space: nowrap; align-self: flex-start; }

  .back { all: unset; cursor: pointer; font-size: 12px; color: var(--gx-sub); padding: 4px 2px 10px; font-family: inherit; }
  .back:hover { color: var(--gx-accent); }
  .detail { display: flex; flex-direction: column; }
  .d-head { display: flex; align-items: center; gap: 13px; margin-bottom: 14px; }
  .icon-sq.lg { width: 48px; height: 48px; border-radius: 12px; font-size: 17px; }
  .d-title { min-width: 0; }
  .d-title h2 { margin: 0; font-size: 17px; font-weight: 500; color: var(--gx-fg); line-height: 1.2; }
  .d-meta { font-size: 12px; color: var(--gx-sub); margin-top: 3px; }
  .d-title .badge { display: inline-block; margin-top: 6px; }
  .d-desc { font-size: 13px; color: var(--gx-sub); line-height: 1.6; margin: 2px 0 18px; }
  .err { margin: 0 0 12px; font-size: 12px; color: #d93025; }
  .set { all: unset; cursor: pointer; font-size: 12px; padding: 6px 12px; border-radius: 7px; color: #fff; background: var(--gx-accent); font-family: inherit; text-align: center; }
  .set:hover:not(:disabled) { filter: brightness(1.06); }
  .set:disabled { opacity: .5; cursor: default; background: var(--gx-fill); color: var(--gx-dim); border: 1px solid var(--gx-border); }
  .set.wide { display: block; padding: 11px; font-size: 13px; }
  .set.wide + .set.wide { margin-top: 8px; }
  .set.secondary { background: var(--gx-fill); color: var(--gx-fg); border: 1px solid var(--gx-border); }
  .set.secondary:hover:not(:disabled) { background: var(--gx-fill-hover); filter: none; }
  .note { margin: 8px 2px 0; font-size: 11.5px; color: var(--gx-sub); }
  .gestures { border-top: 1px solid var(--gx-border); padding-top: 10px; margin-bottom: 12px; }
  .gestures h4 { margin: 10px 0 6px; font-size: 12px; font-weight: 500; color: var(--gx-fg); }
  .gest { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--gx-fg); padding: 4px 0; cursor: pointer; }
  .gest input { accent-color: var(--gx-accent); }
  .gest-note { margin: 4px 0 0; font-size: 11px; color: var(--gx-dim); }
  .net { border-top: 1px solid var(--gx-border); margin-top: 16px; padding-top: 8px; }
  .net h4 { margin: 6px 0 8px; font-size: 12px; font-weight: 500; color: var(--gx-fg); }
  .net-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .net-row { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border: 1px solid var(--gx-border); border-radius: 8px; background: var(--gx-fill); }
  .net-host { flex: 1; min-width: 0; font-size: 12px; color: var(--gx-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .net-state { flex-shrink: 0; font-size: 10.5px; padding: 1px 7px; border-radius: 10px; background: var(--gx-fill-hover); color: var(--gx-dim); }
  .net-state.ok { background: rgba(30,142,62,.12); color: #1e8e3e; }
  .net-state.no { background: rgba(217,48,37,.10); color: #d93025; }
  .net-revoke { all: unset; cursor: pointer; flex-shrink: 0; font-size: 11px; padding: 3px 9px; border-radius: 7px; color: var(--gx-sub); border: 1px solid var(--gx-border); font-family: inherit; }
  .net-revoke:hover { background: var(--gx-fill-hover); color: var(--gx-fg); }
  .net-note { margin: 8px 2px 0; font-size: 11px; line-height: 1.5; color: var(--gx-dim); }
  .empty { text-align: center; color: var(--gx-sub); padding: 36px 12px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .about p { margin: 0 0 10px; font-size: 12px; line-height: 1.55; color: var(--gx-sub); }
  .about-head { display: flex; align-items: baseline; gap: 8px; margin: 6px 0 8px; }
  .about-name { font-size: 16px; font-weight: 500; color: var(--gx-fg); }
  .about-ver { font-size: 12px; color: var(--gx-dim); }
  .about .link { all: unset; cursor: pointer; box-sizing: border-box; display: block; width: 100%; text-align: center; font-size: 12px; font-weight: 500; font-family: inherit; color: var(--gx-accent); padding: 9px 12px; border: 1px solid var(--gx-border); border-radius: 9px; margin: 2px 0 14px; }
  .about .link:hover { background: var(--gx-fill-hover); }
  .ack { border-top: 1px solid var(--gx-border); padding-top: 10px; }
  .ack h4 { margin: 10px 0 4px; font-size: 12px; font-weight: 500; color: var(--gx-fg); }
  .ack p { margin: 0 0 6px; font-size: 11.5px; line-height: 1.55; color: var(--gx-sub); }
  .ack-list { margin: 0 0 8px; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
  .ack-list li { font-size: 11.5px; color: var(--gx-sub); line-height: 1.4; }
  .ack-name { color: var(--gx-fg); font-weight: 500; }
  footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-top: 1px solid var(--gx-border); color: var(--gx-dim); font-size: 11px; }
</style>
