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

  const APP_VERSION = '1.0.0';
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

  function refresh() {
    try { plugins = runtime.listPlugins() || []; } catch (e) { plugins = []; }
  }

  async function openSettings(p) {
    if (!p || !p.hasSettings) return;
    try { await runtime.openSettings(p.id); } catch (e) { /* ignore */ }
  }

  function openFolder() { try { runtime.openPluginFolder && runtime.openPluginFolder(); } catch (e) {} }

  const select = (p) => { selectedId = p.id; };
  const back = () => { selectedId = null; };
  $: selected = plugins.find((p) => p.id === selectedId) || null;

  let lastOpen = false;
  $: if (open && !lastOpen) { lastOpen = true; selectedId = null; refresh(); }
  $: if (!open) lastOpen = false;
</script>

{#if open}
  <div class="bk {theme}" transition:fade={{ duration: 160 }} on:click={() => requestClose()} on:keydown role="button" tabindex="-1" aria-label="Close"></div>
  <aside class="panel {theme}" transition:fly={{ x: 380, duration: 300, easing: cubicOut }} role="dialog" aria-label="Neogebra plugins">
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
        <div><h1>Neogebra</h1><span class="sub">Plugins {isMock ? '· preview' : ''}</span></div>
      </div>
      <button class="icon" on:click={() => requestClose()} aria-label="Close">✕</button>
    </header>

    {#if !selected}
      <nav class="tabs">
        <button class:active={view === 'plugins'} on:click={() => (view = 'plugins')}>Plugins</button>
        <button class:active={view === 'settings'} on:click={() => (view = 'settings')}>About</button>
      </nav>
    {/if}

    <div class="body">
      {#if selected}
        <!-- plugin detail page — slides + fades in from the right -->
        <div class="page" in:fly|global={{ x: 30, duration: 280, easing: cubicOut }}>
          <button class="back" on:click={back} aria-label="Back to plugins">‹ Plugins</button>
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
                {#if selected.builtin}<span class="badge">built-in</span>{/if}
              </div>
            </div>
            {#if selected.error}<p class="err">⚠ {selected.error}</p>{/if}
            {#if selected.description}<p class="d-desc">{selected.description}</p>{/if}
            <button class="set wide" on:click={() => openSettings(selected)} disabled={!selected.hasSettings}>
              {selected.hasSettings ? 'Open settings' : 'No settings'}
            </button>
          </div>
        </div>
      {:else if view === 'plugins'}
        <div class="page" in:fly|global={{ x: -24, duration: 260, easing: cubicOut }}>
          <div class="toolbar">
            <span class="count">{plugins.length} {plugins.length === 1 ? 'plugin' : 'plugins'}</span>
            <button class="ghost" on:click={refresh}>Refresh</button>
          </div>

          {#if plugins.length === 0}
            <div class="empty"><p>No plugins yet.</p><small>Add them in the Neogebra manager.</small></div>
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
          <p>A lightweight, non-invasive plugin framework for GeoGebra. It boots through a proxy layer and never modifies GeoGebra's own files in place.</p>

          <a class="link" href={GITHUB_URL} target="_blank" rel="noopener">★ GitHub repository</a>

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

    <footer><span>v1.0.0</span><span class="hint">Right-Shift to toggle</span></footer>
  </aside>
{/if}

<style>
  /* Brand: GeoGebra purple #6557d3 / blue #1565c0. */
  :host { all: initial; }
  .panel, .bk {
    --gx-accent: #6557d3; --gx-accent-soft: rgba(101,87,211,.12);
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
  .empty { text-align: center; color: var(--gx-sub); padding: 36px 12px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .about p { margin: 0 0 10px; font-size: 12px; line-height: 1.55; color: var(--gx-sub); }
  .about-head { display: flex; align-items: baseline; gap: 8px; margin: 6px 0 8px; }
  .about-name { font-size: 16px; font-weight: 500; color: var(--gx-fg); }
  .about-ver { font-size: 12px; color: var(--gx-dim); }
  .about .link { display: inline-block; font-size: 12px; color: var(--gx-accent); text-decoration: none; padding: 7px 12px; border: 1px solid var(--gx-border); border-radius: 8px; margin-bottom: 12px; }
  .about .link:hover { background: var(--gx-fill-hover); }
  .ack { border-top: 1px solid var(--gx-border); padding-top: 10px; }
  .ack h4 { margin: 10px 0 4px; font-size: 12px; font-weight: 500; color: var(--gx-fg); }
  .ack p { margin: 0 0 6px; font-size: 11.5px; line-height: 1.55; color: var(--gx-sub); }
  .ack-list { margin: 0 0 8px; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
  .ack-list li { font-size: 11.5px; color: var(--gx-sub); line-height: 1.4; }
  .ack-name { color: var(--gx-fg); font-weight: 500; }
  footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-top: 1px solid var(--gx-border); color: var(--gx-dim); font-size: 11px; }
</style>
