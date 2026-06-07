/**
 * store.js — tiny shared constants & Svelte stores for the panel.
 */
import { writable } from 'svelte/store';

export const KEY = 'ggb-extend';

/** Plugin list (array of normalized manifests + `enabled`). */
export const plugins = writable([]);

/** Global settings (opacity, hotkey, theme). */
export const settings = writable({ opacity: 0.92, hotkey: 'RightShift', theme: 'dark' });

/** Loading / error UI state. */
export const ui = writable({ loading: false, error: null, root: '' });
