// host-theme — ONE source of truth for framework/plugin UI theming (P3-1).
//
// Three theme mechanisms used to coexist (CSS-variable reads, background
// luminance sampling, hardcoded colors sprinkled through UIs). This module
// unifies them: a complete light/dark token set derived from the live GeoGebra
// theme (colors + host font), plus a change feed so open UIs follow a theme
// switch instead of "refreshing once when opened".

import { readGgbTheme, detectThemeMode } from './algebra-row.js';
import { subscribeDom } from './shared-observer.js';

/**
 * Full token set for the CURRENT (or given) mode. UIs must consume these
 * instead of hardcoding any color; fontFamily comes from the host so panels
 * read as part of GeoGebra.
 * @param {('light'|'dark')} [mode]
 */
export function themeTokens(mode) {
  const m = mode === 'light' || mode === 'dark' ? mode : detectThemeMode();
  const ggb = readGgbTheme();
  const dark = m === 'dark';
  return {
    mode: m,
    // host-derived
    fontFamily: ggb.fontFamily,
    primary: ggb.primary,
    primaryText: '#ffffff',
    // surfaces
    surface: dark ? '#2b2d31' : '#ffffff',
    surfaceAlt: dark ? 'rgba(255,255,255,.06)' : '#f4f5f9',
    backdrop: 'rgba(20,22,30,.4)',
    // text
    text: dark ? '#ececf0' : '#1d1d1f',
    textSub: dark ? '#b7bcc7' : '#5b616e',
    // lines
    border: dark ? 'rgba(255,255,255,.12)' : '#e3e6ee',
    // shadow
    shadow: '0 16px 48px rgba(0,0,0,.35)',
  };
}

/**
 * Watch for host theme switches. Fires cb(newMode) whenever the sampled mode
 * flips. Uses the shared DOM observer (debounced) plus a slow safety poll
 * (theme flips that only touch attributes/styles don't produce childList
 * mutations). Returns an unsubscribe function.
 */
export function onThemeChange(cb, opts = {}) {
  if (typeof document === 'undefined') return () => {};
  let last = detectThemeMode();
  let timer = null;
  const check = () => {
    const m = detectThemeMode();
    if (m === last) return;
    last = m;
    try { cb(m); } catch { /* listener errors are isolated */ }
  };
  const debounced = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; check(); }, opts.debounceMs || 200);
  };
  const unsub = subscribeDom(debounced);
  const poll = setInterval(check, opts.pollMs || 2500);
  // In Node (tests), don't let the poll keep the process alive.
  if (poll && typeof poll.unref === 'function') poll.unref();
  return () => {
    unsub();
    clearInterval(poll);
    if (timer) { clearTimeout(timer); timer = null; }
  };
}

export default themeTokens;
