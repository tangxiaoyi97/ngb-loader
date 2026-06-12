<script>
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import PluginCard from './lib/PluginCard.svelte';
  import Settings from './lib/Settings.svelte';

  /** Injected from mount.js — bridges to Electron IPC (or mock in preview). */
  export let hostApi;
  /** Controlled by the Right-Shift hotkey in mount.js. */
  export let open = false;

  let view = 'plugins'; // 'plugins' | 'settings'
  let plugins = [];
  let settings = { opacity: 0.92, hotkey: 'RightShift', theme: 'dark' };
  let loading = false;
  let error = null;
  let root = '';
  let isMock = hostApi && hostApi.isMock;

  async function refresh() {
    loading = true;
    error = null;
    try {
      const res = await hostApi.getPlugins();
      if (res && res.ok) {
        plugins = res.plugins || [];
        root = res.root || '';
      } else {
        error = (res && res.error) || 'Failed to load plugins';
      }
      const s = await hostApi.getSettings();
      if (s && s.ok) settings = { ...settings, ...s.settings };
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    } finally {
      loading = false;
    }
  }

  async function onToggle(event) {
    const { id, enabled } = event.detail;
    // optimistic
    plugins = plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
    try {
      const res = await hostApi.togglePlugin(id, enabled);
      if (!res || !res.ok) throw new Error((res && res.error) || 'toggle failed');
    } catch (e) {
      // revert on failure
      plugins = plugins.map((p) => (p.id === id ? { ...p, enabled: !enabled } : p));
      error = String(e.message || e);
    }
  }

  async function openFolder() {
    try { await hostApi.openPluginFolder(); } catch (e) { error = String(e.message || e); }
  }

  async function onSettingsChange(event) {
    settings = { ...settings, ...event.detail };
    try { await hostApi.setSettings(event.detail); } catch (e) { error = String(e.message || e); }
  }

  // Load whenever the panel opens (fresh state each time).
  let lastOpen = false;
  $: if (open && !lastOpen) { lastOpen = true; refresh(); }
  $: if (!open) lastOpen = false;

  onMount(() => { /* preview convenience: nothing eager */ });

  $: panelOpacity = settings.opacity ?? 0.92;
</script>

{#if open}
  <!-- Backdrop: subtle dim, click to close -->
  <div
    class="ggbx-backdrop"
    transition:fade={{ duration: 180 }}
    on:click={() => (open = false)}
    on:keydown={(e) => e.key === 'Escape' && (open = false)}
    role="button"
    tabindex="-1"
    aria-label="Close panel"
  ></div>

  <!-- Sliding glass sidebar -->
  <div
    class="ggbx-panel"
    style="--ggbx-opacity: {panelOpacity}"
    transition:fly={{ x: 380, duration: 320, easing: cubicOut }}
    role="dialog"
    aria-label="GGB-Extend plugin manager"
  >
    <header class="ggbx-header">
      <div class="ggbx-brand">
        <span class="ggbx-logo">⬡</span>
        <div class="ggbx-titles">
          <h1>GGB-Extend</h1>
          <span class="ggbx-sub">Plugin Manager {isMock ? '· preview' : ''}</span>
        </div>
      </div>
      <button class="ggbx-icon-btn" title="Close" on:click={() => (open = false)} aria-label="Close">✕</button>
    </header>

    <nav class="ggbx-tabs">
      <button class:active={view === 'plugins'} on:click={() => (view = 'plugins')}>Plugins</button>
      <button class:active={view === 'settings'} on:click={() => (view = 'settings')}>Settings</button>
    </nav>

    <div class="ggbx-body">
      {#if view === 'plugins'}
        <div class="ggbx-toolbar">
          <span class="ggbx-count">{plugins.length} installed</span>
          <div class="ggbx-toolbar-actions">
            <button class="ggbx-ghost" on:click={refresh} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button class="ggbx-ghost" on:click={openFolder}>Open folder</button>
          </div>
        </div>

        {#if error}
          <div class="ggbx-error" transition:fade>{error}</div>
        {/if}

        {#if loading && plugins.length === 0}
          <div class="ggbx-empty">Loading plugins…</div>
        {:else if plugins.length === 0}
          <div class="ggbx-empty">
            <p>No plugins yet.</p>
            <button class="ggbx-primary" on:click={openFolder}>Open plugins folder</button>
            <small>Drop a plugin folder (with <code>manifest.json</code>) inside, then Refresh.</small>
          </div>
        {:else}
          <ul class="ggbx-list">
            {#each plugins as p (p.id)}
              <li transition:fly={{ y: 8, duration: 200 }}>
                <PluginCard plugin={p} on:toggle={onToggle} />
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <Settings {settings} on:change={onSettingsChange} />
      {/if}
    </div>

    <footer class="ggbx-footer">
      <span>v0.1.0</span>
      <span class="ggbx-hint">Right-Shift to toggle</span>
    </footer>
  </div>
{/if}

<style>
  /* All styles are scoped to the shadow root, so they cannot leak to GeoGebra
     and GeoGebra's CSS cannot reach in. We still reset aggressively. */
  :host { all: initial; }

  .ggbx-backdrop {
    position: fixed; inset: 0;
    background: rgba(8, 10, 16, 0.28);
    backdrop-filter: blur(1.5px);
    pointer-events: auto;
  }

  .ggbx-panel {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 360px;
    max-width: 92vw;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    color: #e8eaf0;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    /* Glassmorphism */
    background: linear-gradient(160deg, rgba(28, 30, 42, var(--ggbx-opacity, 0.92)) 0%, rgba(18, 19, 28, var(--ggbx-opacity, 0.92)) 100%);
    -webkit-backdrop-filter: blur(28px) saturate(160%);
    backdrop-filter: blur(28px) saturate(160%);
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: -24px 0 60px rgba(0, 0, 0, 0.45);
  }

  .ggbx-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 18px 12px;
  }
  .ggbx-brand { display: flex; align-items: center; gap: 12px; }
  .ggbx-logo {
    font-size: 22px; line-height: 1;
    color: #7aa2ff;
    filter: drop-shadow(0 0 8px rgba(122, 162, 255, 0.6));
  }
  .ggbx-titles h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0.2px; }
  .ggbx-sub { font-size: 11px; color: #9aa0b4; }

  .ggbx-icon-btn {
    all: unset; cursor: pointer;
    width: 26px; height: 26px; border-radius: 8px;
    display: grid; place-items: center;
    color: #aab; font-size: 13px;
    transition: background 0.15s, color 0.15s;
  }
  .ggbx-icon-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }

  .ggbx-tabs {
    display: flex; gap: 4px;
    margin: 0 14px 8px;
    padding: 4px;
    background: rgba(255,255,255,0.04);
    border-radius: 10px;
  }
  .ggbx-tabs button {
    all: unset; cursor: pointer;
    flex: 1; text-align: center;
    padding: 7px 0; border-radius: 7px;
    color: #aab; font-weight: 500;
    transition: background 0.18s, color 0.18s;
  }
  .ggbx-tabs button.active {
    background: rgba(122,162,255,0.18);
    color: #cdddff;
    box-shadow: inset 0 0 0 1px rgba(122,162,255,0.25);
  }

  .ggbx-body { flex: 1; overflow-y: auto; padding: 4px 14px 14px; }
  .ggbx-body::-webkit-scrollbar { width: 8px; }
  .ggbx-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 8px; }

  .ggbx-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    margin: 6px 2px 12px;
  }
  .ggbx-count { color: #9aa0b4; font-size: 12px; }
  .ggbx-toolbar-actions { display: flex; gap: 6px; }

  .ggbx-ghost, .ggbx-primary {
    all: unset; cursor: pointer; font-size: 12px;
    padding: 6px 10px; border-radius: 8px;
    transition: background 0.15s, transform 0.05s;
  }
  .ggbx-ghost { color: #b9c0d4; border: 1px solid rgba(255,255,255,0.1); }
  .ggbx-ghost:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
  .ggbx-ghost:disabled { opacity: 0.5; cursor: default; }
  .ggbx-primary { color: #fff; background: rgba(122,162,255,0.9); }
  .ggbx-primary:hover { background: rgba(122,162,255,1); }
  .ggbx-primary:active { transform: translateY(1px); }

  .ggbx-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }

  .ggbx-empty {
    text-align: center; color: #9aa0b4;
    padding: 36px 12px; display: flex; flex-direction: column; gap: 12px; align-items: center;
  }
  .ggbx-empty small { font-size: 11px; opacity: 0.8; }
  .ggbx-empty code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; }

  .ggbx-error {
    background: rgba(255, 86, 86, 0.14);
    border: 1px solid rgba(255, 86, 86, 0.35);
    color: #ffb4b4;
    padding: 8px 10px; border-radius: 8px; margin-bottom: 10px; font-size: 12px;
  }

  .ggbx-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 18px; border-top: 1px solid rgba(255,255,255,0.06);
    color: #6b7186; font-size: 11px;
  }
  .ggbx-hint { opacity: 0.8; }
</style>
