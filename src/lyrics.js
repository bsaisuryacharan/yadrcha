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

async function live(song, signal) {
  const all = store.get(LIVE_KEY, {});
  const cached = all[song.id];
  if (cached && Date.now() - cached.ts < LIVE_TTL) return cached.data;
  const enc = encodeURIComponent;
  const base = `https://lrclib.net/api/get?artist_name=${enc(song.artist)}&track_name=${enc(song.title)}`;
  const attempts = [
    `${base}&album_name=${enc(song.movie)}&duration=${song.duration || ''}`,
    base,
    `https://lrclib.net/api/search?q=${enc(`${song.title} ${song.movie}`)}`,
  ];
  let found = null, answered = false;
  for (const url of attempts) {
    try {
      const r = await fetch(url, { signal });
      answered = true;
      if (!r.ok) continue;
      let d = await r.json();
      if (Array.isArray(d)) d = d.find((x) => x?.syncedLyrics) || d.find((x) => x?.plainLyrics);
      if (d?.syncedLyrics || d?.plainLyrics) { found = { synced: d.syncedLyrics || null, plain: d.plainLyrics || null }; break; }
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
