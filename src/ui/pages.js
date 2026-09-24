// Page builders. Each returns { el, title?, onShow? }. The router in app.js
// caches pages so scroll position survives navigating back.

import { catalog, ERAS, eraById, filterKey, filterLabel, isAllFilter, mkey } from '../catalog.js';
import { albumsOfTheDay, artistsFor, dailyMixes, freshCount, heroCovers, mixById } from '../engine.js';
import { library } from '../library.js';
import { player } from '../player.js';
import { art, collage, coverColor, debounce, fmtTotal, greeting, h, haptic, hashColor, icon, plural, rgb, toast } from '../util.js';
import {
  albumCard, artistCard, contextPlayButton, eraChips, go, mixCard, rail, section, share, songMenu, songRow, syncRows, yearPicker,
} from './components.js';

const NOW = new Date().getFullYear();
const WORKER = 'https://yadrcha-ai.bcharan197.workers.dev';

function page(cls = '') {
  return h('div.page' + (cls ? '.' + cls : ''));
}

/** Sticky header bar for detail pages: back button + fading title. */
function detailBar(el, title, extra) {
  const bar = h('div.bar',
    h('button.icon-btn', { type: 'button', 'aria-label': 'Back', onclick: () => history.length > 1 ? history.back() : go('#/') }, icon('arrow_back')),
    h('div.bar-title', title),
    extra || null);
  el.addEventListener('scroll', () => {
    const o = Math.max(0, Math.min(1, (el.scrollTop - 190) / 70));
    el.style.setProperty('--bar-o', o.toFixed(2));
  }, { passive: true });
  return bar;
}
function tintFrom(el, url, key) {
  const c = hashColor(key);
  el.style.setProperty('--page-tint', rgb(c));
  coverColor(url, key).then((col) => el.style.setProperty('--page-tint', rgb(col)));
}
const playFrom = (ctx, ids) => (s) => player.playList(ctx, ids, s.id, { shuffle: false });

/* ======================================================================
   HOME
   ====================================================================== */
export function HomePage() {
  const el = page();
  const render = () => {
    const f = library.prefs.filter;
    el.replaceChildren();
    const frag = document.createDocumentFragment();

    frag.append(h('header.top',
      h('div.brand-dot', { 'aria-hidden': 'true' }),
      h('div.greet', h('small', new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })), h('h1', greeting())),
      h('a.icon-btn', { href: '#/recent', 'aria-label': 'Recently played' }, icon('history'))));

    frag.append(eraChips(f, (nf) => { library.setPref('filter', nf); render(); el.scrollTo({ top: 0 }); }));
    frag.append(radioHero(f));

    // Jump back in — recent contexts as quick tiles
    const tiles = quickTiles();
    if (tiles.length >= 2) frag.append(h('div', { style: { marginTop: '22px' } }, h('div.tiles', tiles)));

    // Daily mixes
    const mixes = dailyMixes();
    if (mixes.length) frag.append(section('Made for you', rail(mixes.map(mixCard)), { sub: 'Fresh mixes every day · songs you haven’t heard' }));

    // Albums of the day (filter aware)
    const albums = albumsOfTheDay(f, 12);
    if (albums.length) {
      frag.append(section(isAllFilter(f) ? 'Albums for today' : `${filterLabel(f)} albums for today`,
        rail(albums.map((a) => albumCard(a))),
        { sub: 'A new set every morning', more: h('a', { href: eraHref(f) }, 'See all') }));
    }

    // New releases
    if (isAllFilter(f) || (f.kind === 'era' && f.id === '2020s') || (f.kind === 'year' && f.year >= NOW - 1)) {
      const latest = catalog.latestAlbums(16);
      if (latest.length) frag.append(section('New releases', rail(latest.map((a) => albumCard(a, { sub: `${a.year} • ${plural(a.songs.length, 'song')}` }))), { sub: 'Latest Telugu film albums' }));
    }

    // Just added to the catalogue
    const added = catalog.newlyAdded(3).filter((s) => !library.heard.has(s.id)).slice(0, 5);
    if (added.length) {
      const list = h('div.list', added.map((s) => songRow(s)));
      frag.append(section('Just added', list, { sub: 'New in Yadrcha since yesterday' }));
    }

    // Artists
    const artists = artistsFor(f, 12);
    if (artists.length) frag.append(section(isAllFilter(f) ? 'Voices & composers' : `Voices of ${filterLabel(f)}`, rail(artists.map(artistCard))));

    // Travel through time
    if (isAllFilter(f)) {
      const tilesEl = h('div.browse', ERAS.filter((e) => e.id !== 'all').map(eraTile));
      frag.append(section('Travel through time', tilesEl, { sub: 'Every song matched to its film’s release year' }));
    }

    frag.append(h('div.detail-foot', { style: { textAlign: 'center', paddingTop: '30px' } },
      `${catalog.songs.length.toLocaleString()} songs • ${catalog.albumList.length.toLocaleString()} albums`,
      catalog.updated ? h('div', `Catalogue refreshed ${new Date(catalog.updated).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`) : null));
    el.append(frag);
    syncRows(el);
  };
  render();
  let lastDay = new Date().getDate();
  return {
    el,
    onShow() {
      // Re-render on a new day or after library changes elsewhere.
      if (new Date().getDate() !== lastDay || el.dataset.stale) { lastDay = new Date().getDate(); delete el.dataset.stale; render(); }
    },
    invalidate() { el.dataset.stale = '1'; },
  };
}

function eraHref(f) {
  return f?.kind === 'year' ? `#/year/${f.year}` : `#/era/${f?.id || 'all'}`;
}

function radioHero(f) {
  const ctxId = 'radio:' + (f.kind === 'year' ? f.year : f.id);
  const fresh = freshCount(f);
  const total = catalog.count(f);
  const covers = heroCovers(f);
  const hero = h('div.hero' + (player.ctx?.id === ctxId && player.playing ? '.playing' : ''), { dataset: { ctx: ctxId } },
    h('div.hero-stack', covers.map((c, i) => art(c, { key: 'hero' + i }))),
    h('div.hero-eyebrow', h('span.live'), isAllFilter(f) ? 'Yadrcha Radio' : `${filterLabel(f)} Radio`),
    h('h2', isAllFilter(f) ? 'Endless random Telugu hits' : f.kind === 'year' ? `The best of ${f.year}, on shuffle` : `${filterLabel(f)} Telugu hits, on shuffle`),
    h('p', fresh === total ? 'Every song is new to you' : `${fresh.toLocaleString()} songs you haven’t heard yet`),
    h('div.hero-row',
      contextPlayButton(ctxId, () => player.playRadio(f)),
      h('div.meta', `${total.toLocaleString()} songs`, h('br'), 'No repeats, ever')));
  coverColor(covers[2] || covers[0], 'hero' + filterKey(f)).then((c) => hero.style.setProperty('--hero', rgb(c)));
  if (!total) {
    hero.querySelector('p').textContent = 'No songs for this pick yet — the catalogue grows every day';
  }
  return hero;
}

function quickTiles() {
  const out = [];
  if (library.likes.size) {
    out.push(h('a.tile', { href: '#/liked' }, h('div.art.liked-art', icon('favorite', true)), h('b', 'Liked Songs')));
  }
  for (const e of library.recentContexts(10)) {
    if (out.length >= 6) break;
    if (e.t === 'album') {
      const a = catalog.albums.get(e.id);
      if (a) out.push(h('a.tile', { href: `#/album/${a.id}` }, art(a.thumb, { key: a.id }), h('b', a.name)));
    } else if (e.t === 'mix') {
      const m = mixById(e.id);
      if (m) out.push(h('a.tile', { href: `#/mix/${encodeURIComponent(m.id)}` }, collage(m.covers, m.id), h('b', m.title)));
    } else if (e.t === 'artist') {
      const ar = catalog.artists.get(e.id.replace(/^artist:/, ''));
      if (ar) out.push(h('a.tile', { href: `#/artist/${ar.key}` }, art(ar.cover, { key: ar.key, iconName: 'person' }), h('b', ar.name)));
    } else if (e.t === 'radio' && e.filter) {
      const f = e.filter;
      out.push(h('a.tile', {
        href: '#/', onclick: (ev) => { ev.preventDefault(); haptic(); player.playRadio(f); },
      }, h('div.art', { style: { background: `linear-gradient(135deg, rgb(${rgb(hashColor('era' + (f.id || f.year)))}), #111)`, display: 'grid', placeItems: 'center' } }, icon('radio')), h('b', e.title)));
    }
  }
  return out;
}

function eraTile(e) {
  const c = hashColor('era' + e.id);
  const top = catalog.albumsIn({ kind: 'era', id: e.id }).sort((a, b) => b.plays - a.plays)[0];
  return h('a.browse-tile', { href: `#/era/${e.id}`, style: { '--c': `rgb(${rgb(c)})` } },
    h('span', e.label), h('small', plural(catalog.count({ kind: 'era', id: e.id }), 'song')),
    top ? art(top.thumb, { key: top.id }) : null);
}

/* ======================================================================
   SEARCH
   ====================================================================== */
export function SearchPage() {
  const el = page();
  const input = h('input', { type: 'search', placeholder: 'Songs, films, singers, years', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search' });
  const clear = h('button.icon-btn', { type: 'button', 'aria-label': 'Clear', hidden: true, onclick: () => { input.value = ''; run(); input.focus(); } }, icon('close'));
  const head = h('div.search-head', h('h1', 'Search'), h('label.searchbox', icon('search'), input, clear));
  const body = h('div');
  el.append(head, body);

  let onlineCtrl = null;
  const run = () => {
    const q = input.value.trim();
    clear.hidden = !q;
    head.classList.toggle('compact', !!q);
    body.replaceChildren(q.length < 2 ? browse() : results(q));
    syncRows(body);
  };
  const browse = () => {
    const frag = h('div');
    if (library.searches.length) {
      frag.append(h('div.section-head', { style: { marginTop: '8px' } }, h('h2', { style: { fontSize: '17px' } }, 'Recent searches'),
        h('button.link', { type: 'button', onclick: () => { library.clearSearches(); run(); } }, 'Clear')));
      for (const q of library.searches) {
        frag.append(h('button.recent-search', { type: 'button', style: { width: '100%' }, onclick: () => { input.value = q; run(); } }, icon('history'), q));
      }
    }
    frag.append(section('Browse by era', h('div.browse', [
      ...ERAS.filter((e) => e.id !== 'all').map(eraTile),
      h('button.browse-tile', { type: 'button', style: { '--c': '#3a3a48' }, onclick: () => yearPicker(null, (f) => go(eraHref(f))) },
        h('span', 'Pick a year'), h('small', `1950 – ${NOW}`), h('div.art', { style: { display: 'grid', placeItems: 'center', background: '#555' } }, icon('calendar_month'))),
    ])));
    return frag;
  };
  const results = (q) => {
    const yearMatch = /^(19[3-9]\d|20[0-4]\d)$/.exec(q);
    const r = catalog.search(q);
    const frag = h('div');
    if (yearMatch && catalog.years.get(+q)) {
      frag.append(h('a.lib-item', { href: `#/year/${q}` },
        h('div.art', { style: { display: 'grid', placeItems: 'center', background: `rgb(${rgb(hashColor('y' + q))})` } }, icon('calendar_month')),
        h('div.row-main', h('div.row-title', `Songs from ${q}`), h('div.row-sub', plural(catalog.years.get(+q), 'song')))));
    }
    if (!r.top && !yearMatch) {
      frag.append(h('div.empty', icon('search_off'), h('h3', `No results for “${q}”`), h('p', 'Try another spelling — or search all of JioSaavn below.')));
    }
    if (r.top) {
      const t = r.top;
      let card;
      if (t.kind === 'song') {
        const s = t.item;
        card = h('div.top-result', { role: 'button', onclick: () => { library.addSearch(q); player.playSong(s); } },
          art(s.thumb, { key: s.albumId }),
          h('div', h('h3', s.title), h('div.row-sub', h('span.badge', 'SONG'), `${s.artist} • ${s.movie}`)),
          h('button.play-fab.sm', { type: 'button', 'aria-label': 'Play', onclick: (e) => { e.stopPropagation(); library.addSearch(q); player.playSong(s); } }, icon('play_arrow', true)));
      } else if (t.kind === 'album') {
        const a = t.item;
        card = h('a.top-result', { href: `#/album/${a.id}`, onclick: () => library.addSearch(q) },
          art(a.cover, { key: a.id }),
          h('div', h('h3', a.name), h('div.row-sub', h('span.badge', 'ALBUM'), `${a.year || ''} • ${plural(a.songs.length, 'song')}`)),
          contextPlayButton('album:' + a.id, () => player.playList({ type: 'album', id: 'album:' + a.id, title: a.name }, a.songs.map((s) => s.id)), { sm: true }));
      } else {
        const ar = t.item;
        card = h('a.top-result.round', { href: `#/artist/${ar.key}`, onclick: () => library.addSearch(q) },
          art(ar.cover, { key: ar.key, round: true, iconName: 'person' }),
          h('div', h('h3', ar.name), h('div.row-sub', h('span.badge', 'ARTIST'), plural(ar.songs.length, 'song'))));
      }
      frag.append(section('Top result', card));
    }
    if (r.songs.length) {
      const list = h('div.list');
      const show = (n) => list.replaceChildren(...r.songs.slice(0, n).map((s) => songRow(s, { onPlay: (x) => { library.addSearch(q); player.playSong(x); } })));
      show(6);
      const more = r.songs.length > 6 ? h('button.link', { type: 'button', onclick: (e) => { show(40); e.target.remove(); syncRows(list); } }, 'See all') : null;
      frag.append(section('Songs', list, { more }));
    }
    if (r.albums.length) frag.append(section('Albums', rail(r.albums.map((a) => albumCard(a)))));
    if (r.artists.length) frag.append(section('Artists', rail(r.artists.map(artistCard))));
    const onlineBox = h('div');
    frag.append(section('Not finding it?', h('div', { style: { padding: '0 var(--gutter)' } },
      h('button.pill-btn.outline', { type: 'button', onclick: (e) => { e.target.closest('button').remove(); searchOnline(q, onlineBox); } }, icon('travel_explore'), `Search all of JioSaavn for “${q}”`)), {}));
    frag.append(onlineBox);
    return frag;
  };

  async function searchOnline(q, box) {
    if (onlineCtrl) onlineCtrl.abort();
    onlineCtrl = new AbortController();
    box.replaceChildren(h('div.empty', h('p', 'Searching JioSaavn…')));
    try {
      const r = await fetch(`${WORKER}/search?q=${encodeURIComponent(q)}`, { signal: onlineCtrl.signal });
      const data = r.ok ? await r.json() : { results: [] };
      const items = (data.results || []).filter((x) => x.id);
      if (!items.length) { box.replaceChildren(h('div.empty', h('p', 'Nothing more found online.'))); return; }
      box.replaceChildren(h('div.list', items.map((x) => {
        const known = catalog.byId.get(x.id);
        if (known) return songRow(known);
        return h('div.row', { role: 'button', onclick: () => playOnline(x.id) },
          art(x.cover, { key: x.id }),
          h('div.row-main', h('div.row-title', x.title), h('div.row-sub', `${x.artist} • ${x.movie}${x.year ? ` (${x.year})` : ''}`)),
          h('span.badge', { style: { marginRight: '12px' } }, 'WEB'));
      })));
    } catch (e) {
      if (e.name !== 'AbortError') box.replaceChildren(h('div.empty', h('p', 'Online search is unavailable right now.')));
    }
  }

  const debounced = debounce(run, 160);
  input.addEventListener('input', debounced);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { library.addSearch(input.value); input.blur(); } });
  run();
  return {
    el,
    onShow(params) {
      if (params?.focus) setTimeout(() => input.focus(), 250);
      syncRows(el);
    },
  };
}

let cryptoReady = null;
function loadCrypto() {
  if (window.CryptoJS) return Promise.resolve();
  if (!cryptoReady) {
    cryptoReady = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.min.js';
      s.onload = res; s.onerror = rej;
      document.head.append(s);
    });
  }
  return cryptoReady;
}
async function playOnline(id) {
  toast('Loading…', 1200);
  try {
    const [r] = await Promise.all([fetch(`${WORKER}/play?id=${encodeURIComponent(id)}`), loadCrypto()]);
    const d = await r.json();
    const C = window.CryptoJS;
    const dec = C.DES.decrypt({ ciphertext: C.enc.Base64.parse(d.encryptedUrl) }, C.enc.Utf8.parse('38346591'), { mode: C.mode.ECB, padding: C.pad.Pkcs7 });
    const url = dec.toString(C.enc.Utf8).trim().replace(/_(96|128)\.mp4$/, '_160.mp4');
    if (!url.startsWith('http')) throw new Error('decrypt');
    const song = {
      id: d.id, title: d.title, artist: d.artist, movie: d.movie, music: '', url,
      cover: d.cover, thumb: (d.cover || '').replace(/500x500/, '150x150'), year: d.year, duration: d.duration, plays: 0,
      albumId: 'web:' + mkey(d.movie), hasLyrics: false, noLyrics: false, added: null,
    };
    catalog.byId.set(song.id, song);
    player.playSong(song);
  } catch {
    toast('Couldn’t load that song');
  }
}

/* ======================================================================
   LIBRARY
   ====================================================================== */
export function LibraryPage() {
  const el = page();
  const render = () => {
    el.replaceChildren();
    el.append(h('header.top', h('div.brand-dot'), h('h1', 'Your Library'),
      h('a.icon-btn', { href: '#/search?focus=1', 'aria-label': 'Search' }, icon('search'))));

    const mins = Math.round(library.stats.seconds / 60);
    const listened = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
    el.append(h('div.stat-strip',
      h('div.stat', h('b', library.heard.size.toLocaleString()), h('small', 'Songs heard')),
      h('div.stat', h('b', listened), h('small', 'Listened')),
      h('div.stat', h('b', library.heardToday().toLocaleString()), h('small', 'New today'))));

    const list = h('div', { style: { marginTop: '14px' } });
    list.append(
      h('a.lib-item', { href: '#/liked' }, h('div.art.liked-art', icon('favorite', true)),
        h('div.row-main', h('div.row-title', 'Liked Songs'), h('div.row-sub', h('span.ms.pin', 'push_pin'), plural(library.likes.size, 'song')))),
      h('a.lib-item', { href: '#/recent' }, h('div.art', { style: { display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg,#1f6f5c,#0f2d27)' } }, icon('history')),
        h('div.row-main', h('div.row-title', 'Recently played'), h('div.row-sub', h('span.ms.pin', 'push_pin'), 'Your listening history'))),
    );
    const items = [
      ...[...library.albums.entries()].map(([id, at]) => ({ at, a: catalog.albums.get(id) })).filter((x) => x.a),
      ...[...library.artists.entries()].map(([key, at]) => ({ at, ar: catalog.artists.get(key) })).filter((x) => x.ar),
    ].sort((x, y) => y.at - x.at);
    for (const it of items) {
      if (it.a) {
        list.append(h('a.lib-item', { href: `#/album/${it.a.id}` }, art(it.a.thumb, { key: it.a.id }),
          h('div.row-main', h('div.row-title', it.a.name), h('div.row-sub', `Album • ${it.a.year || ''}`))));
      } else {
        list.append(h('a.lib-item.round', { href: `#/artist/${it.ar.key}` }, art(it.ar.cover, { key: it.ar.key, round: true, iconName: 'person' }),
          h('div.row-main', h('div.row-title', it.ar.name), h('div.row-sub', 'Artist'))));
      }
    }
    el.append(list);
    if (!items.length) {
      el.append(h('div.empty', icon('library_add'), h('h3', 'Build your library'),
        h('p', 'Tap ♡ on songs you love, save albums, and follow singers — they’ll all live here.')));
    }
  };
  render();
  library.on((what) => { if (['likes', 'albums', 'artists'].includes(what)) render(); });
  return { el, onShow: render };
}

/* ======================================================================
   ALBUM
   ====================================================================== */
export function AlbumPage(id) {
  const a = catalog.albums.get(id);
  const el = page();
  if (!a) { el.append(detailBar(el, ''), h('div.empty', icon('album'), h('h3', 'Album not found'), h('p', 'It may have been removed from the catalogue.'))); return { el }; }
  const ctxId = 'album:' + a.id;
  const ids = a.songs.map((s) => s.id);
  const ctx = { type: 'album', id: ctxId, title: a.name };
  tintFrom(el, a.cover, a.id);

  const saveBtn = h('button.icon-btn' + (library.isSaved(a.id) ? '.liked' : ''), {
    type: 'button', 'aria-label': 'Save album',
    onclick: () => {
      const on = library.toggleAlbum(a.id);
      saveBtn.classList.toggle('liked', on);
      saveBtn.querySelector('.ms').textContent = on ? 'check_circle' : 'add_circle';
      toast(on ? 'Saved to Your Library' : 'Removed from Your Library');
      haptic(10);
    },
  }, icon(library.isSaved(a.id) ? 'check_circle' : 'add_circle', library.isSaved(a.id)));
  const shuffleBtn = h('button.icon-btn', {
    type: 'button', 'aria-label': 'Shuffle play',
    onclick: () => { haptic(); player.playList(ctx, ids, null, { shuffle: true }); },
  }, icon('shuffle'));

  const byline = a.artists.slice(0, 3).join(', ');
  el.append(
    h('div.detail-bg'),
    detailBar(el, a.name),
    h('div.detail',
      h('div.detail-cover', art(a.cover, { key: a.id, eager: true })),
      h('div.detail-info',
        h('h1', a.name),
        h('div.by', byline),
        h('div.meta', ['Album', a.year || 'Year unknown', plural(a.songs.length, 'song') + ', ' + fmtTotal(a.duration)].join(' • '))),
      h('div.detail-actions',
        saveBtn,
        h('button.icon-btn', { type: 'button', 'aria-label': 'Share', onclick: () => share(a.name, `${a.name} (${a.year}) on Yadrcha`, `#/album/${a.id}`) }, icon('ios_share')),
        h('div.spacer'),
        shuffleBtn,
        contextPlayButton(ctxId, () => player.playList(ctx, ids, null, { shuffle: false }))),
      h('div.list', a.songs.map((s, i) => songRow(s, { index: i, showCover: false, showAlbum: false, ctxId, onPlay: playFrom(ctx, ids) }))),
      h('div.detail-foot', h('b', a.year ? `Released ${a.year}` : 'Release year unknown'), a.music ? `Music by ${a.music}` : null),
    ));

  // More from the same year / same lead artist
  if (a.year) {
    const same = catalog.albumList.filter((x) => x.year === a.year && x.id !== a.id).sort((x, y) => y.plays - x.plays).slice(0, 12);
    if (same.length) el.append(section(`More from ${a.year}`, rail(same.map((x) => albumCard(x))), { more: h('a', { href: `#/year/${a.year}` }, 'See all') }));
  }
  const lead = catalog.artists.get(mkey(a.artists[0] || ''));
  if (lead) {
    const others = [...lead.albumIds].filter((x) => x !== a.id).map((x) => catalog.albums.get(x)).filter(Boolean).sort((x, y) => y.plays - x.plays).slice(0, 12);
    if (others.length) el.append(section(`More with ${lead.name}`, rail(others.map((x) => albumCard(x))), { more: h('a', { href: `#/artist/${lead.key}` }, 'See all') }));
  }
  return { el, title: a.name, onShow: () => syncRows(el) };
}

/* ======================================================================
   ARTIST
   ====================================================================== */
export function ArtistPage(key) {
  const ar = catalog.artists.get(key);
  const el = page();
  if (!ar) { el.append(detailBar(el, ''), h('div.empty', icon('person'), h('h3', 'Artist not found'))); return { el }; }
  const ctxId = 'artist:' + ar.key;
  const ids = ar.songs.map((s) => s.id);
  const ctx = { type: 'artist', id: ctxId, title: ar.name };
  tintFrom(el, ar.cover, ar.key);
  const following = () => library.isFollowing(ar.key);
  const follow = h('button.pill-btn.outline', {
    type: 'button',
    onclick: () => { const on = library.toggleArtist(ar.key); follow.textContent = on ? 'Following' : 'Follow'; haptic(10); },
  }, following() ? 'Following' : 'Follow');

  const albums = [...ar.albumIds].map((x) => catalog.albums.get(x)).filter(Boolean).sort((x, y) => (y.year || 0) - (x.year || 0));
  const popular = h('div.list');
  const showPopular = (n) => popular.replaceChildren(...ar.songs.slice(0, n).map((s, i) => songRow(s, { onPlay: playFrom(ctx, ids), ctxId })));
  showPopular(5);

  el.append(
    h('div.detail-bg'),
    detailBar(el, ar.name),
    h('div.detail',
      h('div.detail-cover.round', art(ar.cover, { key: ar.key, round: true, iconName: 'person', eager: true })),
      h('div.detail-info', { style: { textAlign: 'center' } },
        h('h1', ar.name),
        h('div.meta', [plural(ar.songs.length, 'song'), plural(albums.length, 'film'), ar.span ? `${ar.span[0]}–${ar.span[1]}` : null].filter(Boolean).join(' • '))),
      h('div.detail-actions',
        follow,
        h('div.spacer'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Shuffle play', onclick: () => player.playList(ctx, ids, null, { shuffle: true }) }, icon('shuffle')),
        contextPlayButton(ctxId, () => player.playList(ctx, ids, null, { shuffle: true }))),
      section('Popular', popular, {
        more: ar.songs.length > 5 ? h('button.link', { type: 'button', onclick: (e) => { showPopular(30); e.target.remove(); syncRows(popular); } }, 'See more') : null,
      })));
  if (albums.length) el.append(section('Films', rail(albums.slice(0, 30).map((a) => albumCard(a, { sub: `${a.year || ''} • ${plural(a.songs.length, 'song')}` })))));
  return { el, title: ar.name, onShow: () => { library.pushHistory({ t: 'artist', id: 'artist:' + ar.key, title: ar.name }); syncRows(el); } };
}

/* ======================================================================
   ERA / YEAR
   ====================================================================== */
export function EraPage(f) {
  const el = page();
  const label = filterLabel(f);
  const ctxId = 'radio:' + (f.kind === 'year' ? f.year : f.id);
  const color = hashColor('era' + (f.kind === 'year' ? eraOfYearId(f.year) : f.id));
  el.style.setProperty('--page-tint', rgb(color));
  const albums = catalog.albumsIn(f).slice().sort((a, b) => b.plays - a.plays);
  const songs = catalog.pool(f).slice().sort((a, b) => b.plays - a.plays);
  const era = f.kind === 'era' ? eraById(f.id) : null;

  el.append(
    h('div.detail-bg'),
    detailBar(el, label),
    h('div.hero-header',
      h('div.eyebrow', f.kind === 'year' ? 'Year' : 'Era'),
      h('h1', f.kind === 'era' && f.id === 'all' ? 'Every era' : label),
      h('div.meta', `${plural(songs.length, 'song')} • ${plural(albums.length, 'album')}`),
      era?.blurb ? h('div.meta', era.blurb) : null),
    h('div.detail-actions',
      h('button.pill-btn.outline', { type: 'button', onclick: () => { library.setPref('filter', f); go('#/'); } }, icon('home'), 'Set on Home'),
      h('div.spacer'),
      contextPlayButton(ctxId, () => player.playRadio(f))));

  // Year pills to drill down (decades) or step around (years)
  const pills = h('div.chips', { style: { marginTop: '10px' } });
  if (f.kind === 'era' && f.id !== 'all') {
    for (let y = Math.min(era.to, NOW); y >= Math.max(era.from, 1950); y--) {
      if (catalog.years.get(y)) pills.append(h('a.chip', { href: `#/year/${y}` }, String(y)));
    }
  } else if (f.kind === 'year') {
    for (let y = f.year - 3; y <= Math.min(NOW, f.year + 3); y++) {
      if (catalog.years.get(y)) pills.append(h('a.chip' + (y === f.year ? '.on' : ''), { href: `#/year/${y}` }, String(y)));
    }
  }
  if (pills.childElementCount) el.append(pills);

  if (songs.length) {
    const list = h('div.list', songs.slice(0, 10).map((s) => songRow(s)));
    el.append(section('Biggest songs', list, { sub: 'Most-played on JioSaavn' }));
  }
  if (albums.length) {
    const grid = h('div.grid');
    let shown = 0;
    const more = h('div.load-more');
    const add = () => {
      const next = albums.slice(shown, shown + 24);
      shown += next.length;
      grid.append(...next.map((a) => albumCard(a)));
      if (shown >= albums.length) io.disconnect();
    };
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) add(); }, { root: el, rootMargin: '600px' });
    add();
    el.append(section('Albums', h('div', grid, more)));
    io.observe(more);
  } else {
    el.append(h('div.empty', icon('album'), h('h3', 'Nothing here yet'), h('p', 'The catalogue grows every day — check back soon.')));
  }
  return { el, title: label, onShow: () => syncRows(el) };
}
const eraOfYearId = (y) => ERAS.find((e) => e.id !== 'all' && y >= e.from && y <= e.to)?.id || 'all';

/* ======================================================================
   MIX / LIKED / RECENT (song-list pages)
   ====================================================================== */
function listPage({ title, sub, meta, cover, ctx, songs, empty, color }) {
  const el = page();
  const ids = songs.map((s) => s.id);
  el.style.setProperty('--page-tint', rgb(color));
  el.append(
    h('div.detail-bg'),
    detailBar(el, title),
    h('div.detail',
      h('div.detail-cover', cover),
      h('div.detail-info', h('h1', title), sub ? h('div.by', sub) : null, h('div.meta', meta)),
      songs.length ? h('div.detail-actions',
        h('div.spacer'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Shuffle play', onclick: () => player.playList(ctx, ids, null, { shuffle: true }) }, icon('shuffle')),
        contextPlayButton(ctx.id, () => player.playList(ctx, ids, null, { shuffle: false }))) : null,
      songs.length ? h('div.list', songs.map((s) => songRow(s, { onPlay: playFrom(ctx, ids), ctxId: ctx.id }))) : empty));
  return { el, title, onShow: () => syncRows(el) };
}

export function MixPage(id) {
  const m = mixById(id);
  if (!m) {
    const el = page();
    el.append(detailBar(el, ''), h('div.empty', icon('auto_awesome'), h('h3', 'This mix has refreshed'), h('p', 'Daily mixes change every morning.'), h('a.pill-btn', { href: '#/', style: { marginTop: '16px' } }, 'Go home')));
    return { el };
  }
  const songs = m.songIds.map((id2) => catalog.byId.get(id2)).filter(Boolean);
  const c = collage(m.covers, m.id);
  c.style.setProperty('--mix', `rgb(${rgb(m.color)})`);
  c.append(h('div.mix-stripe'), h('div.mix-label', h('small', 'Daily'), m.title));
  return listPage({
    title: m.title, sub: m.subtitle, meta: `Made for you • Refreshed today • ${plural(songs.length, 'song')}, ${fmtTotal(songs.reduce((t, s) => t + s.duration, 0))}`,
    cover: c, ctx: { type: 'mix', id: m.id, title: m.title }, songs, color: m.color,
  });
}

export function LikedPage() {
  const songs = library.likedIds().map((id) => catalog.byId.get(id)).filter(Boolean);
  return listPage({
    title: 'Liked Songs', meta: plural(songs.length, 'song'),
    cover: h('div.art.liked-art', icon('favorite', true)),
    ctx: { type: 'liked', id: 'liked', title: 'Liked Songs' }, songs, color: [91, 60, 240],
    empty: h('div.empty', icon('favorite'), h('h3', 'Songs you like will appear here'), h('p', 'Tap the heart on any song to save it.')),
  });
}

export function RecentPage() {
  const songs = library.recentSongs(100).map((id) => catalog.byId.get(id)).filter(Boolean);
  return listPage({
    title: 'Recently played', meta: plural(songs.length, 'song'),
    cover: h('div.art', { style: { display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg,#1f6f5c,#0f2d27)' } }, icon('history')),
    ctx: { type: 'recent', id: 'recent', title: 'Recently played' }, songs, color: [31, 111, 92],
    empty: h('div.empty', icon('history'), h('h3', 'Nothing played yet'), h('p', 'Start a radio from Home.')),
  });
}

export { songMenu };
