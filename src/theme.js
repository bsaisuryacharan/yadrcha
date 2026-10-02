// Themes and accent colours.
//
// A theme is a base palette (the CSS blocks in assets/app.css hold the full
// set of roles; the few values here drive previews, contrast tuning and the
// browser's status-bar colour — keep them in sync). An accent is a hue the
// user picks — or "Album art", which follows every song's cover. Whatever
// the source, the accent is re-tuned per theme so text drawn in it keeps
// WCAG AA contrast (4.5:1) on that theme's background and surfaces.
//
// The inline script in index.html applies the cached result before first
// paint, so a reload never flashes the wrong theme.

import { store } from './util.js';

export const THEMES = [
  { id: 'midnight', name: 'Midnight', mode: 'dark', blurb: 'Deep near-black, easy on the eyes',
    bg: '#0a0a0d', surface: '#17171d', surface2: '#202028', fg: '#f7f7f8', fg3: '#7c7c88', accent: '#2ee6a6' },
  { id: 'amoled', name: 'AMOLED Black', mode: 'dark', blurb: 'True black — OLED pixels switch off',
    bg: '#000000', surface: '#0f0f12', surface2: '#18181c', fg: '#ffffff', fg3: '#85858f', accent: '#2ee6a6' },
  { id: 'dusk', name: 'Nord Dusk', mode: 'dark', blurb: 'Arctic blue-grey, from Nord',
    bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', fg: '#eceff4', fg3: '#a5aec0', accent: '#88c0d0' },
  { id: 'mocha', name: 'Mocha', mode: 'dark', blurb: 'Soft pastels, from Catppuccin',
    bg: '#1e1e2e', surface: '#28283a', surface2: '#313244', fg: '#cdd6f4', fg3: '#9399b2', accent: '#cba6f7' },
  { id: 'cool', name: 'Cool White', mode: 'light', blurb: 'Crisp white with a hint of blue',
    bg: '#f5f7fb', surface: '#ffffff', surface2: '#e8edf5', fg: '#0f172a', fg3: '#5b6b82', accent: '#2563eb' },
  { id: 'cloud', name: 'Cloud Dancer', mode: 'light', blurb: 'Pantone’s 2026 Colour of the Year',
    bg: '#f0eee9', surface: '#faf9f6', surface2: '#e5e1d8', fg: '#1c1917', fg3: '#6b655f', accent: '#c2410c' },
];
// "Auto" follows the phone: Cool White by day, Midnight by night.
export const AUTO = { light: 'cool', dark: 'midnight' };

export const ACCENTS = [
  { id: 'theme', name: 'Signature' },
  { id: 'mint', name: 'Mint', hex: '#2ee6a6' },
  { id: 'ocean', name: 'Ocean', hex: '#3b82f6' },
  { id: 'violet', name: 'Violet', hex: '#8b5cf6' },
  { id: 'rose', name: 'Rose', hex: '#f43f5e' },
  { id: 'saffron', name: 'Saffron', hex: '#f59e0b' },
  { id: 'album', name: 'Album' },
];

const KEY = 'yadrcha.theme.v1';
const state = Object.assign({ theme: 'midnight', accent: 'theme' }, store.get(KEY, {}));
const listeners = new Set();
const prefersLight = matchMedia('(prefers-color-scheme: light)');
let albumHex = null;        // current song's cover colour
let chrome = null;          // status-bar colour override (full player)

/* ---------- colour maths ---------- */
const hex2rgb = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
export const rgb2hex = (r, g, b) => '#' + [r, g, b]
  .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function luminance(hex) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hex2rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** WCAG 2 contrast ratio, 1–21. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hsl2hex(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgb2hex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
}
function mix(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  return rgb2hex(...A.map((v, i) => v + (B[i] - v) * t));
}

/**
 * Shift an accent's lightness until text drawn in it reads at ≥4.5:1 on the
 * theme's background and cards — brighter on dark themes, deeper on light.
 */
export function tuneAccent(hex, theme) {
  const dark = theme.mode === 'dark';
  let [h, s, l] = rgb2hsl(hex2rgb(hex));
  for (let i = 0; i < 90; i++) {
    const c = hsl2hex(h, s, l);
    if (contrast(c, theme.bg) >= 4.5 && contrast(c, theme.surface) >= 4.5) return c;
    l = dark ? Math.min(0.97, l + 0.01) : Math.max(0.04, l - 0.01);
    if (!dark && s > 0.8) s -= 0.004;   // deep shades read richer slightly desaturated
  }
  return dark ? '#ffffff' : '#000000';
}
/** Text/icon colour on top of the accent: a tinted near-black or white. */
function inkFor(accent) {
  const [h] = rgb2hsl(hex2rgb(accent));
  const darkInk = hsl2hex(h, 0.55, 0.07);
  return contrast(darkInk, accent) >= contrast('#ffffff', accent) ? darkInk : '#ffffff';
}

/* ---------- state ---------- */
export const prefs = () => ({ theme: state.theme, accent: state.accent });
export const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
export function resolvedTheme(id = state.theme) {
  if (id === 'auto') return themeById(prefersLight.matches ? AUTO.light : AUTO.dark);
  return themeById(id);
}
/** Base (untuned) accent for a theme under an accent preference. */
function baseAccent(theme, pref) {
  if (pref === 'album') return albumHex || theme.accent;
  return ACCENTS.find((a) => a.id === pref)?.hex || theme.accent;
}
export function accentFor(theme, pref = state.accent) {
  const color = tuneAccent(baseAccent(theme, pref), theme);
  return { color, ink: inkFor(color) };
}

function setMeta(color) {
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', color);
}

function paint() {
  const t = resolvedTheme();
  const root = document.documentElement;
  root.dataset.theme = t.id;
  root.dataset.mode = t.mode;
  const a = accentFor(t);
  root.style.setProperty('--accent', a.color);
  root.style.setProperty('--accent-ink', a.ink);
  setMeta(chrome || t.bg);
  // Everything the no-flash script in index.html needs on the next load.
  store.set(KEY, { theme: state.theme, accent: state.accent, resolved: t.id, mode: t.mode, ac: a.color, ink: a.ink, bg: t.bg });
  listeners.forEach((fn) => fn(t));
}

/**
 * Run `apply` as a View Transition whose new state ripples out in a circle
 * from the tap point. Falls back to an instant switch where unsupported or
 * when the user prefers reduced motion.
 */
function reveal(origin, apply) {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce || !origin) { apply(); return; }
  const { x, y } = origin;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // Freeze colour transitions so the "after" snapshot is the final state.
  root.classList.add('vt');
  const vt = document.startViewTransition(apply);
  vt.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 620, easing: 'cubic-bezier(.3,.7,.2,1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
  vt.finished.finally(() => root.classList.remove('vt'));
}

export function setTheme(id, origin) {
  if (id === state.theme) return;
  state.theme = id;
  reveal(origin, paint);
}
export function setAccent(id) {
  if (id === state.accent) return;
  state.accent = id;
  paint();      // the registered --accent property animates the change
}
/** Called with each new song's cover colour ([r,g,b]). */
export function setAlbumColor(rgb) {
  const [, s, l] = rgb2hsl(rgb);
  // Grey or near-black covers make a dull accent: keep the theme's own.
  albumHex = s < 0.18 || l < 0.1 ? null : rgb2hex(...rgb);
  if (state.accent === 'album') paint();
}
/** Status-bar colour while the full player is open (null = theme default). */
export function setChrome(color) {
  chrome = color;
  setMeta(color || resolvedTheme().bg);
}
/** Top colour of the full player for a cover tint, matching the CSS mix. */
export function playerTopColor(rgb) {
  const t = resolvedTheme();
  const tint = rgb2hex(...rgb);
  return t.mode === 'dark' ? mix('#000000', tint, 0.78) : mix('#ffffff', tint, 0.34);
}
export function onTheme(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function initTheme() {
  paint();
  prefersLight.addEventListener('change', () => { if (state.theme === 'auto') paint(); });
}
