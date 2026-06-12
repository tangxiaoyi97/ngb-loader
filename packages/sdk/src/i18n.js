// i18n — minimal localization helper (P3-5). GeoGebra itself is fully
// localized; an English-only panel inside a Chinese GeoGebra reads as foreign.
// This reads the HOST's language and gives UIs a tiny t() — no library.

const SUPPORTED = ['en', 'zh-CN'];

function normalize(raw) {
  const l = String(raw || '').replace('_', '-').toLowerCase();
  if (l.startsWith('zh')) return 'zh-CN';
  return 'en';
}

/**
 * The host's UI language, reduced to a supported locale.
 * Sources, in order: the applet's own language API, the document language,
 * the browser language. Defaults to 'en'.
 */
export function getHostLocale() {
  try {
    const a = typeof window !== 'undefined' ? window.ggbApplet : null;
    if (a && typeof a.getLanguage === 'function') {
      const l = a.getLanguage();
      if (l) return normalize(l);
    }
  } catch { /* next source */ }
  try {
    const l = document.documentElement.lang;
    if (l) return normalize(l);
  } catch { /* next source */ }
  try { return normalize(navigator.language); } catch { return 'en'; }
}

/**
 * Build a t() from per-locale dictionaries: { en: {...}, 'zh-CN': {...} }.
 * Missing keys fall back to English, then to the key itself.
 * Placeholders: t('found {0} items', n).
 * @param {object} dicts
 * @param {string} [locale] override (tests / previews)
 */
export function makeT(dicts, locale) {
  const loc = SUPPORTED.includes(locale) ? locale : getHostLocale();
  const dict = (dicts && dicts[loc]) || {};
  const fallback = (dicts && dicts.en) || {};
  const t = (key, ...args) => {
    let s = dict[key] !== undefined ? dict[key] : (fallback[key] !== undefined ? fallback[key] : key);
    for (let i = 0; i < args.length; i += 1) s = String(s).split(`{${i}}`).join(String(args[i]));
    return s;
  };
  t.locale = loc;
  return t;
}

export default makeT;
