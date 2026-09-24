// Reusable UI pieces: song rows, cards, shelves, the song action sheet,
// and the era/year picker.

import { catalog, ERAS, eraOfYear, filterKey, filterLabel, isAllFilter } from '../catalog.js';
import { library } from '../library.js';
import { player } from '../player.js';
import { art, collage, eqBars, fmtTime, h, haptic, icon, plural, rgb, toast } from '../util.js';
import { closeAllOverlays, openSheet } from './overlay.js';

export const go = (hash) => closeAllOverlays(() => { if (location.hash !== hash) location.hash = hash; });

/* ---------- song row ---------- */
export function songRow(s, { index, onPlay, showCover = true, showAlbum = true, ctxId } = {}) {
  const isCur = player.current?.id === s.id;
  const lead = index != null && !showCover
    ? h('div.num', isCur ? eqBars(!player.playing) : String(index + 1))
    : art(s.thumb, { key: s.albumId });
  const sub = [];
  if (library.isLiked(s.id)) sub.push(h('span.ms.fill', { style: { fontSize: '14px', color: 'var(--accent)' }, text: 'favorite' }));
  if (s.added && s.added === catalog.newestAdded) sub.push(h('span.badge.new', 'NEW'));
  sub.push(h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
    s.artist + (showAlbum ? ` • ${s.movie}` : '') + (showAlbum && s.year ? ` (${s.year})` : '')));
  const row = h('div.row' + (isCur ? '.current' : ''), {
    dataset: { id: s.id, ctx: ctxId || '', idx: index ?? '' },
    role: 'button', tabindex: '0',
    onclick: (e) => { if (e.target.closest('.icon-btn')) return; haptic(); onPlay ? onPlay(s) : player.playSong(s); },
  },
  lead,
  h('div.row-main', h('div.row-title', s.title), h('div.row-sub', sub)),
  h('button.icon-btn', { type: 'button', 'aria-label': 'More options', onclick: (e) => { e.stopPropagation(); songMenu(s); } }, icon('more_vert')));
  return row;
}

/** Re-mark the now-playing row everywhere after a track change. */
export function syncRows(root = document) {
  const id = player.current?.id;
  for (const row of root.querySelectorAll('.row[data-id]')) {
    const on = row.dataset.id === id;
    row.classList.toggle('current', on);
    const num = row.querySelector('.num');
    if (num) {
      if (on) { num.replaceChildren(eqBars(!player.playing)); }
      else if (num.querySelector('.eq')) num.textContent = String(+row.dataset.idx + 1);
    }
  }
  for (const eq of root.querySelectorAll('.eq')) eq.classList.toggle('paused', !player.playing);
}

/* ---------- cards ---------- */
export function albumCard(a, { lg, sub } = {}) {
  return h('a.card' + (lg ? '.lg' : ''), { href: `#/album/${a.id}` },
    art(a.cover, { key: a.id }),
    h('div.card-title', a.name),
    h('div.card-sub', sub ?? [a.year || '', a.artists?.slice(0, 2).join(', ')].filter(Boolean).join(' • ')));
}
export function mixCard(m) {
  const c = collage(m.covers, m.id);
  c.style.setProperty('--mix', `rgb(${rgb(m.color)})`);
  c.append(h('div.mix-stripe'), h('div.mix-label', h('small', 'Daily'), m.title));
  return h('a.card.lg', { href: `#/mix/${encodeURIComponent(m.id)}` }, c, h('div.card-sub', m.subtitle));
}
export function artistCard(ar) {
  return h('a.artist-card', { href: `#/artist/${ar.key}` },
    art(ar.cover, { key: ar.key, round: true, iconName: 'person' }),
    h('div.card-title', ar.name),
    h('div.card-sub', plural(ar.songs.length, 'song')));
}

export function section(title, content, { sub, more } = {}) {
  return h('section.section',
    h('div.section-head', h('div', h('h2', title), sub ? h('small', sub) : null), more || null),
    content);
}
export const rail = (items) => h('div.rail', items);

/* ---------- context play button (album / mix / artist / era) ---------- */
export function contextPlayButton(ctxId, start, { sm } = {}) {
  const btn = h('button.play-fab' + (sm ? '.sm' : ''), { type: 'button', 'aria-label': 'Play', dataset: { ctx: ctxId } }, icon('play_arrow', true));
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    haptic(12);
    if (player.ctx?.id === ctxId && player.current) player.toggle();
    else start();
  });
  syncPlayButton(btn);
  return btn;
}
export function syncPlayButton(btn) {
  const on = player.ctx?.id === btn.dataset.ctx && player.playing;
  btn.querySelector('.ms').textContent = on ? 'pause' : 'play_arrow';
  btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
}
export function syncPlayButtons(root = document) {
  root.querySelectorAll('.play-fab[data-ctx]').forEach(syncPlayButton);
}

/* ---------- song action sheet ---------- */
export function songMenu(s, { inPlayer = false } = {}) {
  openSheet((body, close) => {
    const album = catalog.albums.get(s.albumId);
    const artists = catalog.artistsOfSong(s);
    const item = (ic, label, fn, cls = '') => h('button.sheet-item' + cls, { type: 'button', onclick: () => { haptic(); fn(); } }, icon(ic), label);
    const liked = library.isLiked(s.id);
    body.append(
      item('favorite', liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', () => {
        const on = library.toggleLike(s.id);
        toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs');
        close();
      }, liked ? '.liked' : ''),
      item('playlist_play', 'Play next', () => { player.playNext(s); toast('Playing next'); close(); }),
      item('queue_music', 'Add to queue', () => { player.addToQueue(s); toast('Added to queue'); close(); }),
      album ? item('album', 'Go to album', () => go(`#/album/${album.id}`)) : null,
      ...artists.slice(0, 3).map((ar) => item('person', `Go to ${ar.name}`, () => go(`#/artist/${ar.key}`))),
      item('radio', 'Start song radio', () => { player.playSong(s); close(); }),
      item('ios_share', 'Share', () => { share(s.title, `${s.title} — ${s.movie}`, `#/album/${s.albumId}`); close(); }),
      inPlayer ? item('bedtime', player.sleepLabel() ? `Sleep timer · ${player.sleepLabel()}` : 'Sleep timer', () => { close(); setTimeout(sleepMenu, 380); }) : null,
    );
    return h('div.sheet-head', art(s.thumb, { key: s.albumId }),
      h('div', { style: { minWidth: 0 } },
        h('h3.row-title', s.title),
        h('div.row-sub', `${s.artist} • ${s.movie}${s.year ? ` (${s.year})` : ''}`)));
  }, { name: 'song-menu' });
}

export function sleepMenu() {
  openSheet((body, close) => {
    const opt = (label, val) => h('button.sheet-item', {
      type: 'button',
      onclick: () => {
        haptic();
        player.setSleep(val);
        toast(val == null ? 'Sleep timer off' : val === 'track' ? 'Pausing at the end of this song' : `Pausing in ${val} minutes`);
        close();
      },
    }, icon(val == null ? 'close' : 'bedtime'), label);
    body.append(opt('15 minutes', 15), opt('30 minutes', 30), opt('45 minutes', 45), opt('1 hour', 60),
      opt('End of this song', 'track'), player.sleepLabel() ? opt('Turn off timer', null) : null);
    return h('div.sheet-head', h('div', h('h3', 'Sleep timer'), h('div.row-sub', player.sleepLabel() || 'Music fades out, you drift off')));
  }, { name: 'sleep' });
}

export async function share(title, text, hash) {
  const url = location.origin + location.pathname + hash;
  try {
    if (navigator.share) { await navigator.share({ title, text, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {}
}

/* ---------- era / year picker ---------- */
export function eraChips(current, onPick) {
  const wrap = h('div.chips', { role: 'tablist' });
  const isYear = current?.kind === 'year';
  for (const e of ERAS) {
    const on = !isYear && (current?.id || 'all') === e.id;
    wrap.append(h('button.chip' + (on ? '.on' : ''), {
      type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
      onclick: () => { haptic(); onPick({ kind: 'era', id: e.id }); },
    }, e.short));
  }
  wrap.append(h('button.chip' + (isYear ? '.on' : '.ghost'), {
    type: 'button', onclick: () => { haptic(); yearPicker(current, onPick); },
  }, icon('calendar_month'), isYear ? String(current.year) : 'Pick a year'));
  requestAnimationFrame(() => wrap.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
  return wrap;
}

export function yearPicker(current, onPick) {
  openSheet((body, close) => {
    const years = catalog.years;
    const now = new Date().getFullYear();
    const wrapper = h('div.years');
    for (const e of [...ERAS].filter((x) => x.id !== 'all').reverse()) {
      const from = Math.max(e.from, 1950), to = Math.min(e.to, now);
      const total = catalog.count({ kind: 'era', id: e.id });
      if (!total) continue;
      const grid = h('div.year-grid');
      for (let y = to; y >= from; y--) {
        const n = years.get(y) || 0;
        const on = current?.kind === 'year' && current.year === y;
        grid.append(h('button.year' + (on ? '.on' : ''), {
          type: 'button', disabled: !n,
          onclick: () => { haptic(); close(); onPick({ kind: 'year', year: y }); },
        }, String(y), h('small', n ? String(n) : '–')));
      }
      wrapper.append(
        h('h4', h('span', `${e.label} · ${plural(total, 'song')}`),
          h('button', { type: 'button', onclick: () => { close(); onPick({ kind: 'era', id: e.id }); } }, `All ${e.short}`)),
        grid);
    }
    body.append(wrapper);
    return h('div.sheet-head', h('div', h('h3', 'Pick a year'), h('div.row-sub', 'Every song is matched to its film’s release year')));
  }, { name: 'year-picker' });
}

export function filterSummary(f) {
  const n = catalog.count(f);
  return isAllFilter(f) ? `${n.toLocaleString()} songs from every era` : `${n.toLocaleString()} songs from ${filterLabel(f)}`;
}
export { filterKey, eraOfYear, fmtTime };
