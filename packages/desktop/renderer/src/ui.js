// Design tokens & primitives.
export const T = {
  bg: '#f4f5f9',           // app canvas
  surface: '#ffffff',      // cards
  surfaceAlt: '#f7f8fc',   // subtle fills / hover
  border: '#e6e8f0',       // hairline
  borderStrong: '#d6dae6',
  text: '#1d1d1f',
  sub: '#5a606e',
  dim: '#9aa0ad',
  purple: '#6557d3',
  purpleDark: '#4f43b8',
  purpleSoft: '#efeefc',
  blue: '#1a73e8',
  red: '#d93b39',
  redSoft: '#fdeceb',
  // semantic colors used by logs/toasts/the plugin toggle (NOT the status dot)
  green: '#16a34a',
  greenSoft: '#e7f7ee',
  amber: '#e8950c',
  amberSoft: '#fdf2e0',
  // neutral gray for the "not injected" status (the only non-theme status color)
  gray: '#9aa0ad',
  graySoft: '#eef0f4',
  grayDot: '#b6bcc8',
  font: "'Roboto', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif",
  // shadows like geogebra.org cards
  shadowCard: '0 1px 2px rgba(28,30,46,.06), 0 2px 8px rgba(28,30,46,.06)',
  shadowRaise: '0 4px 16px rgba(28,30,46,.12)',
};

// Two status colors only: GRAY = not injected (neutral), PURPLE = injected
// (GeoGebra theme). `missing` keeps red since a vanished path is a real error.
// `fg`/`bg` are the pill text/background; `dot` is the small status dot.
export const stateMeta = (s) => ({
  pristine: { label: 'Not injected', fg: T.sub, bg: T.graySoft, dot: T.grayDot },
  injected: { label: 'Injected', fg: T.purple, bg: T.purpleSoft, dot: T.purple },
  missing: { label: 'Path missing', fg: T.red, bg: T.redSoft, dot: T.red },
  unknown: { label: 'Not injected', fg: T.sub, bg: T.graySoft, dot: T.grayDot },
}[s] || { label: 'Not injected', fg: T.sub, bg: T.graySoft, dot: T.grayDot });

export const btn = (variant = 'ghost', size = 'md') => {
  const pad = size === 'sm' ? '7px 12px' : '9px 18px';
  const base = {
    appearance: 'none', cursor: 'pointer', fontSize: size === 'sm' ? 12 : 13, fontWeight: 500,
    padding: pad, borderRadius: 999, fontFamily: 'inherit', border: '1px solid transparent',
    lineHeight: 1.2, whiteSpace: 'nowrap',
  };
  if (variant === 'primary') return { ...base, background: T.purple, color: '#fff', boxShadow: '0 1px 2px rgba(101,87,211,.35)' };
  if (variant === 'danger') return { ...base, background: '#fff', color: T.red, border: `1px solid ${T.border}` };
  return { ...base, background: '#fff', border: `1px solid ${T.borderStrong}`, color: T.text };
};

/** className for a button variant — pairs with the CSS in index.html for hover. */
export const btnClass = (variant = 'ghost') => `nx-btn nx-btn-${variant}`;
