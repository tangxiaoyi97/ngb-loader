<script>
  import { createEventDispatcher } from 'svelte';
  export let plugin;
  const dispatch = createEventDispatcher();

  function toggle() {
    dispatch('toggle', { id: plugin.id, enabled: !plugin.enabled });
  }

  $: initials = (plugin.name || '?').trim().slice(0, 2).toUpperCase();
</script>

<div class="card" class:broken={plugin.broken}>
  <div class="icon" aria-hidden="true">
    {#if plugin.icon}
      <img src={plugin.icon} alt="" />
    {:else}
      <span>{initials}</span>
    {/if}
  </div>

  <div class="meta">
    <div class="line1">
      <span class="name">{plugin.name}</span>
      <span class="ver">v{plugin.version}</span>
    </div>
    <div class="line2">
      <span class="author">{plugin.author}</span>
    </div>
    {#if plugin.description}
      <p class="desc">{plugin.description}</p>
    {/if}
    {#if plugin.broken}
      <p class="warn">⚠ {plugin.error || 'invalid plugin'}</p>
    {/if}
  </div>

  <button
    class="switch"
    class:on={plugin.enabled}
    role="switch"
    aria-checked={plugin.enabled}
    aria-label={`Enable ${plugin.name}`}
    on:click={toggle}
    disabled={plugin.broken}
  >
    <span class="knob"></span>
  </button>
</div>

<style>
  .card {
    display: grid;
    grid-template-columns: 40px 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    transition: background 0.18s, border-color 0.18s;
  }
  .card:hover { background: rgba(255, 255, 255, 0.07); border-color: rgba(255,255,255,0.1); }
  .card.broken { opacity: 0.7; }

  .icon {
    width: 40px; height: 40px; border-radius: 10px;
    display: grid; place-items: center;
    background: linear-gradient(135deg, #5b76d8, #7aa2ff);
    color: #fff; font-weight: 700; font-size: 14px;
    box-shadow: 0 4px 12px rgba(91, 118, 216, 0.35);
    overflow: hidden;
  }
  .icon img { width: 100%; height: 100%; object-fit: cover; }

  .meta { min-width: 0; }
  .line1 { display: flex; align-items: baseline; gap: 8px; }
  .name { font-weight: 600; color: #eef0f6; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ver { font-size: 11px; color: #7f86a0; }
  .line2 { margin-top: 1px; }
  .author { font-size: 11px; color: #8b91a8; }
  .desc {
    margin: 5px 0 0; font-size: 12px; color: #a7adc2; line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .warn { margin: 5px 0 0; font-size: 11px; color: #ffb4b4; }

  /* Toggle switch */
  .switch {
    all: unset; cursor: pointer;
    width: 40px; height: 24px; border-radius: 999px;
    background: rgba(255,255,255,0.16);
    position: relative; flex-shrink: 0;
    transition: background 0.22s cubic-bezier(.2,.8,.2,1);
  }
  .switch.on { background: #34c759; box-shadow: 0 0 12px rgba(52,199,89,0.5); }
  .switch:disabled { cursor: default; opacity: 0.5; }
  .knob {
    position: absolute; top: 3px; left: 3px;
    width: 18px; height: 18px; border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    transition: transform 0.22s cubic-bezier(.2,.8,.2,1);
  }
  .switch.on .knob { transform: translateX(16px); }
</style>
