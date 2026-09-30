// Synced lyrics: catalogue shards first (pre-probed at build time), then a
// live LRClib lookup for songs the build hasn't probed yet.

import { catalog } from './catalog.js';
import { fnv1a, store } from './util.js';

const shardCache = new Map();
const LIVE_KEY = 'yadrcha.lyrics.v2';
const LIVE_TTL = 30 * 86400000;
const LIVE_MAX = 150;   // bounded so it can't eat the localStorage quota

export const lyricsShard = (id, n = catalog.shards || 64) => fnv1a(id) % n;

async function fromShard(song) {
  const n = lyricsShard(song.id);
  if (!shardCache.has(n)) {
    // Versioned by catalogue date: shards are rewritten by every refresh.
    const v = encodeURIComponent(catalog.updated || '');
    shardCache.set(n, fetch(`lyrics/${String(n).padStart(2, '0')}.json?v=${v}`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => { shardCache.delete(n); return {}; }));
  }
  const data = await shardCache.get(n);
  return data[song.id] || null;
}

export function parseLRC(text) {
  if (!text) return null;
  const out = [];
  for (const line of text.split('\n')) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length || !words) continue;
    for (const m of stamps) {
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      if (isFinite(t)) out.push({ time: t, text: words });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out.length ? out : null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
  .replace(/th/g, 't').replace(/dh/g, 'd').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/aa/g, 'a')
  .replace(/w/g, 'v').replace(/z/g, 'j').replace(/(.)\1+/g, '$1').replace(/\s+/g, ' ').trim();
const cleanTitle = (t) => String(t || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/\s*[-–]\s*(reprise|remix|lofi|lo-fi|male|female|version|from\b.*|telugu|title song|sad|happy|duet)\b.*$/i, '')
  .replace(/\s+/g, ' ').trim();
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Dice coefficient on bigrams — close enough to difflib for a yes/no check.
  const grams = (x) => { const m = new Map(); for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b); let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) || 0);
  return (2 * hit) / Math.max(1, a.length - 1 + b.length - 1);
}
/** Is this LRCLIB record plausibly the same recording? A wrong song's
 *  lyrics are worse than none. */
function acceptable(song, c) {
  if (!c || !(c.syncedLyrics || c.plainLyrics)) return false;
  const ts = Math.max(similar(cleanTitle(song.title), c.trackName), similar(song.title, c.trackName));
  if (ts < 0.8) return false;
  if (song.duration && c.duration) {
    const diff = Math.abs(song.duration - c.duration);
    return diff <= 12 && (diff <= 5 || ts >= 0.95);
  }
  const who = norm(`${c.artistName || ''} ${c.albumName || ''}`);
  const singers = String(song.artist).split(/\s*[,&]\s*/).map(norm).filter(Boolean);
  return singers.some((x) => who.includes(x.split(' ').pop())) || who.includes(norm(cleanTitle(song.movie)));
}

async function live(song, signal) {
  const all = store.get(LIVE_KEY, {});
  const cached = all[song.id];
  if (cached && Date.now() - cached.ts < LIVE_TTL) return cached.data;
  const enc = encodeURIComponent;
  const title = cleanTitle(song.title), singer = String(song.artist).split(/\s*[,&]\s*/)[0];
  const attempts = [
    `https://lrclib.net/api/get?artist_name=${enc(song.artist)}&track_name=${enc(song.title)}&album_name=${enc(song.movie)}&duration=${song.duration || ''}`,
    `https://lrclib.net/api/search?track_name=${enc(title)}&artist_name=${enc(singer)}`,
    `https://lrclib.net/api/search?track_name=${enc(title)}`,
    `https://lrclib.net/api/search?q=${enc(`${title} ${cleanTitle(song.movie)}`)}`,
  ];
  let found = null, answered = false;
  for (const url of attempts) {
    try {
      const r = await fetch(url, { signal });
      answered = true;
      if (!r.ok) continue;
      const d = await r.json();
      const list = (Array.isArray(d) ? d : [d]).filter((x) => acceptable(song, x));
      const pick = list.find((x) => x.syncedLyrics) || list.find((x) => x.plainLyrics);
      if (pick) { found = { synced: pick.syncedLyrics || null, plain: pick.plainLyrics || null }; break; }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  // Only remember an answer (found or a real "not found") — never an
  // offline failure.
  if (answered) {
    const fresh = store.get(LIVE_KEY, {});
    fresh[song.id] = { ts: Date.now(), data: found };
    const keep = Object.entries(fresh).sort((a, b) => b[1].ts - a[1].ts).slice(0, LIVE_MAX);
    store.set(LIVE_KEY, Object.fromEntries(keep));
  }
  return found;
}

/**
 * → { lines: [{time,text}] } for synced, { plain: [text] } for unsynced,
 *   or null when the song has no lyrics.
 */
export async function getLyrics(song, signal) {
  if (!song) return null;
  let raw = song.lyricsInline;
  if (!raw && song.hasLyrics) raw = await fromShard(song);
  if (raw) {
    const lines = parseLRC(raw);
    if (lines) return { lines };
  }
  if (song.noLyrics && !raw) return null;
  const got = await live(song, signal);
  if (!got) return null;
  const lines = parseLRC(got.synced);
  if (lines) return { lines };
  if (got.plain) return { plain: got.plain.split('\n').map((l) => l.trim()).filter(Boolean) };
  return null;
}
