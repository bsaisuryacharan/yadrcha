// Small shared helpers: DOM building, formatting, storage, seeded RNG,
// cover art + colour extraction, toasts, haptics.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.card', { onclick }, [children]) — tiny hyperscript. */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const icon = (name, fill) => h('span.ms' + (fill ? '.fill' : ''), { 'aria-hidden': 'true', text: name });

export function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtTotal(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const hr = Math.floor(m / 60);
  return `${hr} hr ${m % 60} min`;
}
export const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/* ---------- storage (never throws) ---------- */
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

/* ---------- hashing + seeded randomness ---------- */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(str);
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : fnv1a(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** Pick n items without replacement, biased by weight(item). */
export function weightedPick(items, n, weight, rand = Math.random) {
  // Efraimidis–Spirakis: key = u^(1/w), take the n largest keys.
  const keyed = [];
  for (const it of items) {
    const w = Math.max(1e-6, weight(it));
    keyed.push([Math.pow(rand(), 1 / w), it]);
  }
  keyed.sort((x, y) => y[0] - x[0]);
  return keyed.slice(0, n).map((k) => k[1]);
}

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function greeting(d = new Date()) {
  const hr = d.getHours();
  if (hr < 5) return 'Late night';
  if (hr < 12) return 'Good morning';
  if (hr < 17) return 'Good afternoon';
  if (hr < 21) return 'Good evening';
  return 'Good night';
}

export const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

export function haptic(ms = 8) {
  try { navigator.vibrate && navigator.vibrate(ms); } catch {}
}

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- colours ---------- */
const PALETTE = [
  [232, 90, 79], [245, 166, 35], [80, 180, 120], [66, 133, 244], [155, 89, 182],
  [26, 188, 156], [230, 126, 34], [52, 73, 94], [211, 84, 150], [39, 174, 96],
  [41, 128, 185], [192, 57, 43], [142, 68, 173], [22, 160, 133], [243, 156, 18],
];
export const hashColor = (key) => PALETTE[fnv1a(String(key || '')) % PALETTE.length];
export const rgb = (c) => c.join(',');

const colorCache = new Map(Object.entries(store.get('yadrcha.colors.v1', {})));
let colorSaveTimer;
function saveColors() {
  clearTimeout(colorSaveTimer);
  colorSaveTimer = setTimeout(() => {
    const entries = [...colorCache.entries()].slice(-600);
    store.set('yadrcha.colors.v1', Object.fromEntries(entries));
  }, 1500);
}
/** Dominant, UI-friendly colour of a cover image → [r,g,b]. Cached. */
export function coverColor(url, fallbackKey) {
  if (!url) return Promise.resolve(hashColor(fallbackKey));
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const n = 24, c = document.createElement('canvas');
        c.width = c.height = n;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, n, n);
        const d = x.getImageData(0, 0, n, n).data;
        // Bucket by hue, weighting saturated mid-tones, to find the colour
        // a designer would pick — not the muddy average.
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const l = (max + min) / 510, s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
          if (l < 0.08 || l > 0.94) continue;
          const key = `${r >> 5},${g >> 5},${b >> 5}`;
          const w = 0.25 + s * 1.6 + (1 - Math.abs(l - 0.5)) * 0.6;
          const e = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
          e.w += w; e.r += r * w; e.g += g * w; e.b += b * w;
          buckets.set(key, e);
        }
        let best = null;
        for (const e of buckets.values()) if (!best || e.w > best.w) best = e;
        let col = best ? [best.r / best.w, best.g / best.w, best.b / best.w] : hashColor(fallbackKey);
        col = tame(col);
        colorCache.set(url, col);
        saveColors();
        resolve(col);
      } catch { resolve(hashColor(fallbackKey)); }
    };
    img.onerror = () => resolve(hashColor(fallbackKey));
    img.src = url;
  });
}
/** Keep extracted colours in a range that reads well behind white text. */
function tame([r, g, b]) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  let hh = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const dd = max - min;
    s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
    const R = r / 255, G = g / 255, B = b / 255;
    hh = max === R ? (G - B) / dd + (G < B ? 6 : 0) : max === G ? (B - R) / dd + 2 : (R - G) / dd + 4;
    hh /= 6;
  }
  l = Math.min(0.5, Math.max(0.3, l));
  s = Math.min(0.85, s * 1.1);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)].map((v) => Math.round(v * 255));
}

/* ---------- artwork element with graceful fallback ---------- */
export function art(url, { key, round, cls = '', iconName = 'music_note', eager } = {}) {
  const [r, g, b] = hashColor(key || url);
  const wrap = h('div.art' + (round ? '.round' : '') + (cls ? '.' + cls : ''), {
    style: { background: `linear-gradient(135deg, rgb(${r},${g},${b}), rgb(${r * 0.45 | 0},${g * 0.45 | 0},${b * 0.45 | 0}))` },
  });
  if (url) {
    const img = h('img', { alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async' });
    img.onload = () => { img.classList.add('ok'); wrap.style.background = ''; };
    img.onerror = () => img.remove();
    img.src = url;
    wrap.append(img);
  }
  wrap.append(h('div.ph', icon(iconName)));
  return wrap;
}

/** 2x2 collage of covers (for mixes / playlists). */
export function collage(urls, key) {
  const [r, g, b] = hashColor(key);
  const wrap = h('div.art.collage', { style: { background: `rgb(${r},${g},${b})` } });
  const four = [...new Set(urls.filter(Boolean))].slice(0, 4);
  while (four.length && four.length < 4) four.push(four[four.length % Math.max(1, four.length)]);
  for (const u of four) {
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', style: { width: '100%', height: '100%', objectFit: 'cover' } });
    img.onerror = () => { img.style.visibility = 'hidden'; };
    img.src = u;
    wrap.append(img);
  }
  return wrap;
}

export function eqBars(paused) {
  return h('span.eq' + (paused ? '.paused' : ''), { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
