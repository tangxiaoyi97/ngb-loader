<script>
  import { createEventDispatcher } from 'svelte';
  export let settings = { opacity: 0.92, hotkey: 'RightShift', theme: 'dark' };
  const dispatch = createEventDispatcher();

  function update(patch) {
    dispatch('change', patch);
  }
</script>

<div class="settings">
  <section>
    <label for="opacity">Panel opacity</label>
    <div class="row">
      <input
        id="opacity" type="range" min="0.5" max="1" step="0.01"
        value={settings.opacity}
        on:input={(e) => update({ opacity: parseFloat(e.target.value) })}
      />
      <span class="val">{Math.round((settings.opacity ?? 0.92) * 100)}%</span>
    </div>
  </section>

  <section>
    <span class="label">Toggle hotkey</span>
    <div class="hotkey-display">
      <kbd>Right&nbsp;Shift</kbd>
      <small>Custom hotkeys land in a future release.</small>
    </div>
  </section>

  <section>
    <label for="theme">Theme</label>
    <select id="theme" value={settings.theme} on:change={(e) => update({ theme: e.target.value })}>
      <option value="dark">Dark (default)</option>
      <option value="midnight">Midnight</option>
    </select>
  </section>

  <section class="about">
    <h3>About</h3>
    <p>GGB-Extend is a lightweight, non-invasive plugin framework for GeoGebra.
      It boots through a proxy layer and never modifies GeoGebra's own files in place.</p>
  </section>
</div>

<style>
  .settings { display: flex; flex-direction: column; gap: 20px; padding: 8px 2px; }
  section { display: flex; flex-direction: column; gap: 8px; }
  label, .label { color: #c2c8db; font-weight: 500; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 12px; }
  input[type='range'] { flex: 1; accent-color: #7aa2ff; }
  .val { color: #9aa0b4; font-size: 12px; width: 40px; text-align: right; }

  .hotkey-display { display: flex; flex-direction: column; gap: 6px; }
  kbd {
    align-self: flex-start;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.14);
    border-bottom-width: 2px;
    border-radius: 6px; padding: 4px 10px;
    font-family: ui-monospace, monospace; font-size: 12px; color: #e8eaf0;
  }
  small { color: #7f86a0; font-size: 11px; }

  select {
    all: unset; cursor: pointer;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px; padding: 8px 10px; color: #e8eaf0; font-size: 12px;
  }
  select option { background: #1c1e2a; color: #e8eaf0; }

  .about h3 { margin: 0 0 4px; font-size: 12px; color: #c2c8db; }
  .about p { margin: 0; font-size: 12px; line-height: 1.5; color: #9aa0b4; }
</style>
