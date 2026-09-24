// App shell: boot, hash router with cached pages, tab bar.

import { catalog } from './catalog.js';
import { library } from './library.js';
import { player } from './player.js';
import { $, h, store, toast } from './util.js';
import { syncRows } from './ui/components.js';
import { initNowPlaying, openPlayer } from './ui/nowplaying.js';
import { closeAllOverlays } from './ui/overlay.js';
import {
  AlbumPage, ArtistPage, EraPage, HomePage, LibraryPage, LikedPage, MixPage, RecentPage, SearchPage,
} from './ui/pages.js';

const pagesEl = $('#pages');
const tabs = { home: null, search: null, library: null };
const cache = new Map();      // route -> { el, onShow, scroll }
let current = null;           // { route, entry, tab }
let lastTab = 'home';

function parse(hash) {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  return { path: '/' + parts.join('/'), parts, params };
}

function build({ parts }) {
  const [a, b] = parts;
  switch (a) {
    case undefined: return { tab: 'home', make: HomePage };
    case 'search': return { tab: 'search', make: SearchPage };
    case 'library': return { tab: 'library', make: LibraryPage };
    case 'liked': return { make: LikedPage, fresh: true };
    case 'recent': return { make: RecentPage, fresh: true };
    case 'album': return { make: () => AlbumPage(b) };
    case 'artist': return { make: () => ArtistPage(b) };
    case 'mix': return { make: () => MixPage(b) };
    case 'era': return { make: () => EraPage({ kind: 'era', id: b || 'all' }) };
    case 'year': return { make: () => EraPage({ kind: 'year', year: parseInt(b, 10) }) };
    default: return { tab: 'home', make: HomePage };
  }
}

function route() {
  const r = parse(location.hash);
  const spec = build(r);
  const key = spec.tab || r.path;

  let entry;
  if (spec.tab) {
    entry = tabs[spec.tab] || (tabs[spec.tab] = spec.make());
    lastTab = spec.tab;
  } else {
    entry = !spec.fresh && cache.get(key);
    if (!entry) {
      entry = spec.make();
      if (!spec.fresh) {
        cache.set(key, entry);
        if (cache.size > 14) {
          const [oldKey, old] = cache.entries().next().value;
          if (old !== current?.entry) { old.el.remove(); cache.delete(oldKey); }
        }
      }
    }
  }

  if (current && current.entry !== entry) {
    current.entry.scroll = current.entry.el.scrollTop;
    current.entry.el.hidden = true;
    if (current.fresh) current.entry.el.remove();
  }
  const isNew = !entry.el.isConnected;
  if (isNew) pagesEl.append(entry.el);
  entry.el.hidden = false;
  entry.el.classList.remove('enter', 'enter-tab');
  if (current?.entry !== entry) {
    void entry.el.offsetWidth;
    entry.el.classList.add(spec.tab ? 'enter-tab' : 'enter');
    if (entry.scroll != null) entry.el.scrollTop = entry.scroll;
  }
  entry.onShow?.(r.params);
  current = { route: key, entry, tab: spec.tab, fresh: spec.fresh };

  const activeTab = spec.tab || (['liked', 'recent'].includes(r.parts[0]) ? 'library' : lastTab);
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === activeTab));
  document.title = entry.title ? `${entry.title} — Yadrcha` : 'Yadrcha · Telugu Music';
}

// Re-tapping the active tab scrolls to top / pops back to the tab root.
document.querySelectorAll('.tabbar a').forEach((a) => {
  a.addEventListener('click', (e) => {
    const tab = a.dataset.tab;
    const target = a.getAttribute('href');
    if (current?.tab === tab) {
      e.preventDefault();
      current.entry.el.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (location.hash === target || (target === '#/' && !location.hash)) {
      e.preventDefault();
      route();
    }
  });
});

// The previous version cached the whole catalogue (up to ~5 MB) in
// localStorage; free that quota for likes/history.
for (const k of ['yadrcha.catalog.v4', 'yadrcha.history.v1', 'yadrcha.theme']) store.del(k);

async function boot() {
  player.init($('#audio'));
  initNowPlaying();
  const splash = $('#splash');
  const status = $('#splash-sub');
  const t0 = performance.now();
  try {
    status.textContent = 'Loading the Telugu catalogue…';
    await catalog.load();
  } catch (e) {
    status.replaceChildren('Couldn’t load the catalogue.', h('br'),
      h('button.pill-btn', { type: 'button', style: { marginTop: '14px' }, onclick: () => location.reload() }, 'Try again'));
    return;
  }
  player.restore();
  window.addEventListener('hashchange', route);
  route();
  library.on((what) => {
    if (['likes', 'artists'].includes(what)) tabs.home?.invalidate?.();
    if (what === 'likes') syncRows();
  });
  const wait = Math.max(0, 450 - (performance.now() - t0));
  setTimeout(() => splash.classList.add('hide'), wait);
  if (new URLSearchParams(location.search).get('play') === '1' && player.current) openPlayer();
}

// Desktop keyboard niceties (the app is mobile-first, but these cost nothing).
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) player.next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) player.prev();
  else if (e.key === 'Escape') closeAllOverlays();
});

window.addEventListener('offline', () => toast('You’re offline — playback needs a connection'));

boot();
