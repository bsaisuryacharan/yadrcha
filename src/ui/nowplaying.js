// Mini player, full-screen player, synced lyrics and the queue sheet.

import { catalog } from '../catalog.js';
import { library } from '../library.js';
import { getLyrics } from '../lyrics.js';
import { player } from '../player.js';
import { $, art, coverColor, fmtTime, h, haptic, icon, rgb, toast } from '../util.js';
import { go, share, songMenu, songRow, syncPlayButtons, syncRows } from './components.js';
import { dragToDismiss, hasOverlay, openSheet, popOverlay, pushOverlay } from './overlay.js';

const mini = $('#mini');
const playerEl = $('#player');
let seeking = false;
let lyricsOn = false;
let lyricsFor = null;
let lyricsLines = null;
let lyricsCtrl = null;
let activeLine = -1;

export function initNowPlaying() {
  /* ---------- mini player ---------- */
  $('#mini-open').addEventListener('click', (e) => { if (!e.target.closest('button')) openPlayer(); });
  $('#mini-open').addEventListener('keydown', (e) => { if (e.key === 'Enter') openPlayer(); });
  $('#mini-play').addEventListener('click', () => { haptic(); player.toggle(); });
  $('#mini-next').addEventListener('click', () => { haptic(); player.next(); });
  $('#mini-like').addEventListener('click', () => toggleLike());
  swipeX($('#mini-open'), (dir) => (dir < 0 ? player.next() : player.prev()));

  /* ---------- full player ---------- */
  $('#player-close').addEventListener('click', closePlayer);
  $('#player-more').addEventListener('click', () => player.current && songMenu(player.current, { inPlayer: true }));
  $('#btn-play').addEventListener('click', () => { haptic(12); player.toggle(); });
  $('#btn-next').addEventListener('click', () => { haptic(); player.next(); });
  $('#btn-prev').addEventListener('click', () => { haptic(); player.prev(); });
  $('#btn-shuffle').addEventListener('click', () => {
    haptic();
    if (player.isRadio) { toast('Radio is always shuffled — and never repeats'); return; }
    toast(player.toggleShuffle() ? 'Shuffle on' : 'Shuffle off', 1400);
  });
  $('#btn-repeat').addEventListener('click', () => {
    haptic();
    const r = player.cycleRepeat();
    toast({ off: 'Repeat off', all: 'Repeating all', one: 'Repeating this song' }[r], 1400);
  });
  $('#player-like').addEventListener('click', () => toggleLike());
  $('#player-artist').addEventListener('click', () => {
    const ar = player.current && catalog.artistsOfSong(player.current)[0];
    if (ar) go(`#/artist/${ar.key}`);
  });
  $('#btn-album').addEventListener('click', () => {
    const s = player.current;
    if (s && catalog.albums.has(s.albumId)) go(`#/album/${s.albumId}`);
    else toast('This song isn’t part of an album here');
  });
  $('#btn-queue').addEventListener('click', openQueue);
  $('#btn-lyrics').addEventListener('click', () => setLyrics(!lyricsOn));
  $('#player-ctx-title').parentElement.addEventListener('click', () => {
    const c = player.ctx;
    if (!c) return;
    if (c.type === 'album') go(`#/album/${c.id.slice(6)}`);
    else if (c.type === 'artist') go(`#/artist/${c.id.slice(7)}`);
    else if (c.type === 'mix') go(`#/mix/${encodeURIComponent(c.id)}`);
    else if (c.type === 'liked') go('#/liked');
  });
  dragToDismiss($('#player-grab'), playerEl, closePlayer, { threshold: 140 });
  swipeX($('#player-art'), (dir) => (dir < 0 ? player.next() : player.prev()), $('#player-art'));
  initSeek();

  player.on('track', onTrack);
  player.on('state', onState);
  player.on('time', onTime);
  player.on('mode', onMode);
  player.on('queue', () => { if (queueRender) queueRender(); });
  library.on((w) => { if (w === 'likes') onLikes(); });
  onMode();
}

/* ---------- open / close ---------- */
export function openPlayer() {
  if (!player.current || hasOverlay('player')) return;
  playerEl.classList.add('open');
  playerEl.setAttribute('aria-hidden', 'false');
  pushOverlay('player', () => {
    playerEl.classList.remove('open');
    playerEl.setAttribute('aria-hidden', 'true');
  });
  if (lyricsOn) loadLyrics();
}
export function closePlayer() { popOverlay('player'); }

/* ---------- state sync ---------- */
function onTrack(s) {
  mini.hidden = false;
  if (!document.body.classList.contains('has-mini')) {
    document.body.classList.add('has-mini');
    document.getElementById('app').classList.add('has-mini');
    mini.classList.add('show-in');
  }
  const meta = mini.querySelector('.mini-meta');
  meta.classList.remove('swap'); void meta.offsetWidth; meta.classList.add('swap');
  setImg($('#mini-img'), s.thumb);
  $('#mini-title').textContent = s.title;
  $('#mini-sub').textContent = s.artist;
  setImg($('#player-img'), s.cover);
  $('#player-title').textContent = s.title;
  $('#player-artist').textContent = s.artist;
  const c = player.ctx;
  $('#player-ctx-label').textContent = c?.autoplayFrom ? 'Autoplay' : ({ album: 'Playing from album', artist: 'Playing from artist', mix: 'Playing from your mix', liked: 'Playing from', radio: 'Playing from radio', recent: 'Playing from' }[c?.type] || 'Now playing');
  $('#player-ctx-title').textContent = c?.title || 'Yadrcha';
  coverColor(s.cover, s.albumId).then((col) => {
    if (player.current?.id === s.id) document.documentElement.style.setProperty('--tint', rgb(col));
  });
  document.title = `${s.title} · ${s.artist} — Yadrcha`;
  onLikes();
  syncRows();
  syncPlayButtons();
  document.querySelectorAll('.hero[data-ctx]').forEach((el) => el.classList.toggle('playing', player.ctx?.id === el.dataset.ctx && player.playing));
  if (lyricsOn) loadLyrics();
}

function onState() {
  const playing = player.playing;
  const icon1 = playing ? 'pause' : 'play_arrow';
  $('#mini-play .ms').textContent = icon1;
  $('#mini-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const btn = $('#btn-play');
  btn.classList.toggle('loading', player.loading && playing);
  btn.querySelector('.ms').textContent = player.loading && playing ? 'progress_activity' : icon1;
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#player-art').classList.toggle('paused', !playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  syncPlayButtons();
  document.querySelectorAll('.eq').forEach((e) => e.classList.toggle('paused', !playing));
  document.querySelectorAll('.hero[data-ctx]').forEach((el) => el.classList.toggle('playing', player.ctx?.id === el.dataset.ctx && playing));
}

function onTime() {
  const a = player.audio;
  const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : (player.current?.duration || 0);
  const cur = player._pendingTime && !a.getAttribute('src') ? player._pendingTime : a.currentTime;
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  $('#mini-bar').style.width = pct + '%';
  if (!seeking) {
    $('#seek-fill').style.width = pct + '%';
    $('#seek-knob').style.left = pct + '%';
    $('#t-cur').textContent = fmtTime(cur);
    $('#seek').setAttribute('aria-valuenow', Math.round(pct));
  }
  $('#t-tot').textContent = fmtTime(dur);
  if (lyricsOn && lyricsLines) highlightLyric(cur);
}

function onMode() {
  const sh = $('#btn-shuffle');
  sh.setAttribute('aria-pressed', String(player.shuffle && !player.isRadio));
  const rp = $('#btn-repeat');
  rp.setAttribute('aria-pressed', String(player.repeat !== 'off'));
  rp.querySelector('.ms').textContent = player.repeat === 'one' ? 'repeat_one' : 'repeat';
  const more = $('#player-more .ms');
  more.textContent = player.sleepAt || player.sleepEndOfTrack ? 'bedtime' : 'more_horiz';
}

function onLikes() {
  const on = player.current && library.isLiked(player.current.id);
  for (const b of [$('#mini-like'), $('#player-like')]) {
    b.classList.toggle('liked', !!on);
    b.setAttribute('aria-label', on ? 'Remove from Liked Songs' : 'Add to Liked Songs');
  }
}
function toggleLike() {
  const s = player.current;
  if (!s) return;
  const on = library.toggleLike(s.id);
  haptic(on ? 18 : 8);
  for (const b of [$('#mini-like'), $('#player-like')]) { b.classList.remove('pop'); void b.offsetWidth; if (on) b.classList.add('pop'); }
  toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs', 1500);
}

function setImg(img, url) {
  img.style.opacity = '0';
  img.onload = () => { img.style.transition = 'opacity .3s'; img.style.opacity = '1'; };
  img.onerror = () => { img.removeAttribute('src'); };
  img.src = url || '';
}

/* ---------- seek bar (drag with finger) ---------- */
function initSeek() {
  const seek = $('#seek');
  const track = seek.querySelector('.seek-track');
  const pctAt = (x) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width));
  };
  const dur = () => (isFinite(player.audio.duration) && player.audio.duration) || player.current?.duration || 0;
  const show = (p) => {
    $('#seek-fill').style.width = p * 100 + '%';
    $('#seek-knob').style.left = p * 100 + '%';
    $('#t-cur').textContent = fmtTime(p * dur());
  };
  seek.addEventListener('pointerdown', (e) => {
    seeking = true;
    seek.classList.add('active');
    seek.setPointerCapture(e.pointerId);
    show(pctAt(e.clientX));
  });
  seek.addEventListener('pointermove', (e) => { if (seeking) show(pctAt(e.clientX)); });
  const end = (e) => {
    if (!seeking) return;
    seeking = false;
    seek.classList.remove('active');
    const p = pctAt(e.clientX);
    if (!player.audio.getAttribute('src')) player._pendingTime = p * dur();
    else player.seek(p * dur());
    onTime();
  };
  seek.addEventListener('pointerup', end);
  seek.addEventListener('pointercancel', () => { seeking = false; seek.classList.remove('active'); onTime(); });
  seek.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') player.seek(player.audio.currentTime + 5);
    if (e.key === 'ArrowLeft') player.seek(player.audio.currentTime - 5);
  });
}

/* ---------- horizontal swipe to change track ---------- */
function swipeX(el, onSwipe, visual) {
  let x0 = null, y0 = 0, dx = 0, locked = null;
  el.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; dx = 0; locked = null; });
  el.addEventListener('pointermove', (e) => {
    if (x0 == null) return;
    dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (locked == null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (locked === 'x' && visual) {
      visual.classList.add('swipe');
      visual.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      visual.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 500));
    }
  });
  const end = () => {
    if (x0 == null) return;
    const fire = locked === 'x' && Math.abs(dx) > 70;
    x0 = null;
    if (visual) {
      visual.classList.remove('swipe');
      visual.style.transform = '';
      visual.style.opacity = '';
    }
    if (fire) { haptic(); onSwipe(Math.sign(dx)); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('click', (e) => { if (locked === 'x') { e.stopPropagation(); e.preventDefault(); } }, true);
}

/* ---------- lyrics ---------- */
function setLyrics(on) {
  lyricsOn = on;
  $('#btn-lyrics').setAttribute('aria-pressed', String(on));
  $('#player-lyrics').hidden = !on;
  $('#player-art').style.visibility = on ? 'hidden' : '';
  if (on) loadLyrics();
}
async function loadLyrics() {
  const s = player.current;
  if (!s || lyricsFor === s.id) return;
  lyricsFor = s.id;
  lyricsLines = null;
  activeLine = -1;
  const box = $('#lyrics-lines');
  const scroller = $('#lyrics-scroll');
  box.replaceChildren(h('div.lyrics-empty', h('div', h('div.lyric', { style: { color: 'rgba(255,255,255,.6)', fontSize: '18px' } }, 'Finding lyrics…'))));
  scroller.scrollTop = 0;
  if (lyricsCtrl) lyricsCtrl.abort();
  lyricsCtrl = new AbortController();
  let got = null;
  try { got = await getLyrics(s, lyricsCtrl.signal); } catch { if (player.current?.id !== s.id) return; }
  if (player.current?.id !== s.id) return;
  if (got?.lines) {
    lyricsLines = got.lines;
    box.replaceChildren(...got.lines.map((l, i) => h('p.lyric', { dataset: { i }, onclick: () => { player.seek(l.time); haptic(); } }, l.text)),
      h('div.lyrics-note', 'Lyrics via LRCLIB'));
    highlightLyric(player.audio.currentTime);
  } else if (got?.plain) {
    box.replaceChildren(h('div.lyrics-plain', ...got.plain.map((t) => h('p.lyric', t))), h('div.lyrics-note', 'Unsynced lyrics via LRCLIB'));
  } else {
    box.replaceChildren(h('div.lyrics-empty', h('div', icon('music_note'), h('b', 'No lyrics for this one'), h('div', 'Just enjoy the music ♫'))));
  }
}
function highlightLyric(t) {
  let idx = -1;
  for (let i = 0; i < lyricsLines.length; i++) { if (lyricsLines[i].time <= t + 0.35) idx = i; else break; }
  if (idx === activeLine) return;
  activeLine = idx;
  const lines = $('#lyrics-lines').querySelectorAll('.lyric');
  lines.forEach((el, i) => { el.classList.toggle('on', i === idx); el.classList.toggle('past', i < idx); });
  const el = lines[idx];
  if (el) {
    const sc = $('#lyrics-scroll');
    sc.scrollTo({ top: el.offsetTop - sc.clientHeight * 0.32, behavior: 'smooth' });
  }
}

/* ---------- queue ---------- */
let queueRender = null;
function openQueue() {
  openSheet((body) => {
    queueRender = () => {
      const s = player.current;
      const up = player.upcoming(40);
      body.replaceChildren();
      if (s) {
        body.append(h('div.sheet-title', 'Now playing'),
          h('div.queue-now', art(s.thumb, { key: s.albumId }),
            h('div.row-main', h('div.row-title', { style: { color: 'var(--accent)' } }, s.title), h('div.row-sub', `${s.artist} • ${s.movie}`))));
      }
      const row = (song, kind, i) => {
        const r = songRow(song, { onPlay: () => player.jump(kind, i) });
        const more = r.querySelector('.icon-btn');
        more.replaceChildren(icon('remove_circle_outline'));
        more.setAttribute('aria-label', 'Remove from queue');
        more.onclick = (e) => { e.stopPropagation(); haptic(); player.removeFromQueue(kind, i); };
        return r;
      };
      if (up.user.length) {
        body.append(h('div.sheet-title', 'Next in queue'), h('div.list', up.user.map((x, i) => row(x, 'user', i))));
      }
      const c = player.ctx;
      body.append(h('div.sheet-title', player.isRadio ? `Next on ${c?.title || 'radio'} · never repeats` : `Next from ${c?.title || ''}`));
      if (up.context.length) body.append(h('div.list', up.context.map((x, i) => row(x, 'ctx', i))));
      else body.append(h('div.empty', { style: { padding: '20px' } }, h('p', player.repeat === 'all' ? 'Starting over after this song.' : 'Autoplay continues with radio from the same era.')));
      syncRows(body);
    };
    queueRender();
    return h('div.sheet-head', h('h3', 'Up next'), h('div', { style: { flex: 1 } }),
      h('button.pill-btn', { type: 'button', onclick: () => { toast(player.toggleShuffle() ? 'Shuffle on' : 'Shuffle off', 1200); } }, icon('shuffle'), 'Shuffle'));
  }, { name: 'queue' });
  const obs = new MutationObserver(() => { if (!document.querySelector('.sheet-wrap')) { queueRender = null; obs.disconnect(); } });
  obs.observe(document.getElementById('sheets'), { childList: true });
}
