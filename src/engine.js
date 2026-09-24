// Discovery engine: no-repeat radio picks and the daily-refreshed shelves
// (mixes, albums of the day). Everything "of the day" is seeded by the
// date so it's stable while you browse and new tomorrow.

import { catalog, ERAS, eraOfYear, filterKey, filterLabel, isAllFilter, mkey, splitArtists } from './catalog.js';
import { library } from './library.js';
import { rng, shuffle, store, todayKey, weightedPick, toast, hashColor } from './util.js';

const DAY = todayKey();

function tasteProfile() {
  const artists = new Map();
  for (const id of library.likes.keys()) {
    const s = catalog.byId.get(id);
    if (!s) continue;
    for (const n of splitArtists(s.artist)) {
      const k = mkey(n);
      artists.set(k, (artists.get(k) || 0) + 1);
    }
  }
  for (const k of library.artists.keys()) artists.set(k, (artists.get(k) || 0) + 3);
  return artists;
}

/**
 * Next song for endless radio within a filter.
 * Never repeats a song until every song in the filter has been heard;
 * then that filter starts a fresh cycle.
 */
export function pickRadio(filter, { exclude = new Set(), recent = [] } = {}) {
  const pool = catalog.pool(filter);
  if (!pool.length) return null;
  let fresh = pool.filter((s) => !library.heard.has(s.id) && !exclude.has(s.id));
  if (!fresh.length) {
    library.forgetHeard(pool.map((s) => s.id));
    toast(`You’ve heard all ${pool.length.toLocaleString()} songs in ${filterLabel(filter)} — starting a fresh cycle`, 4000);
    fresh = pool.filter((s) => !exclude.has(s.id));
    if (!fresh.length) fresh = pool;
  }
  // Sample a manageable slice for weighting.
  const r = Math.random;
  const slice = fresh.length > 600 ? shuffle(fresh, r).slice(0, 600) : fresh;

  const taste = tasteProfile();
  const recentAlbums = new Set(recent.slice(-12).map((s) => s.albumId));
  const recentArtists = new Set(recent.slice(-3).flatMap((s) => splitArtists(s.artist).map(mkey)));
  const eraShare = new Map();
  if (isAllFilter(filter)) {
    for (const e of ERAS) if (e.id !== 'all') eraShare.set(e.id, catalog.count({ kind: 'era', id: e.id }) / catalog.songs.length);
  }
  const weight = (s) => {
    let w = Math.pow((s.plays || 0) + 20, 0.16);
    const keys = splitArtists(s.artist).map(mkey);
    const t = keys.reduce((m, k) => Math.max(m, taste.get(k) || 0), 0);
    if (t) w *= 1 + Math.min(1.2, t * 0.25);
    if (recentAlbums.has(s.albumId)) w *= 0.15;
    if (keys.some((k) => recentArtists.has(k))) w *= 0.45;
    if (s.added && catalog.newestAdded && s.added === catalog.newestAdded) w *= 1.4;
    if (eraShare.size) {
      // Balance eras under "All" so a 2020s-heavy catalog still surfaces classics.
      const e = eraOfYear(s.year);
      if (e) w *= Math.pow(1 / Math.max(0.02, eraShare.get(e.id)), 0.4);
    }
    return w;
  };
  return weightedPick(slice, 1, weight, r)[0] || null;
}

/** How many songs in a filter haven't been heard yet. */
export function freshCount(filter) {
  let n = 0;
  for (const s of catalog.pool(filter)) if (!library.heard.has(s.id)) n++;
  return n;
}

/* ---------- daily mixes ---------- */

const MIX_KEY = 'yadrcha.mixes.v1';
const MIX_SIZE = 30;

function buildMix(id, title, subtitle, songs, color, kind) {
  if (songs.length < 8) return null;
  return {
    id, title, subtitle, kind, color,
    songIds: songs.map((s) => s.id),
    covers: [...new Set(songs.map((s) => s.cover))].slice(0, 4),
  };
}

function pickSongs(pool, n, rand, extraWeight = () => 1) {
  const fresh = pool.filter((s) => !library.heard.has(s.id));
  const src = fresh.length >= n ? fresh : pool;
  // One song per album keeps a mix varied.
  const perAlbum = new Map();
  for (const s of shuffle(src, rand)) if (!perAlbum.has(s.albumId)) perAlbum.set(s.albumId, s);
  const uniq = [...perAlbum.values()];
  return weightedPick(uniq.length >= n ? uniq : src, n, (s) => Math.pow((s.plays || 0) + 20, 0.2) * extraWeight(s), rand);
}

export function dailyMixes() {
  const cached = store.get(MIX_KEY, null);
  if (cached && cached.day === DAY && cached.v === catalog.updated && cached.likes === library.likes.size) {
    return cached.mixes.map((m) => ({ ...m, songIds: m.songIds.filter((id) => catalog.byId.has(id)) }));
  }
  const rand = rng('mix:' + DAY);
  const mixes = [];

  // 1. Made from your likes
  const taste = tasteProfile();
  if (taste.size) {
    const pool = catalog.songs.filter((s) => splitArtists(s.artist).some((n) => taste.has(mkey(n))) && !library.likes.has(s.id));
    const m = buildMix('mix:you', 'Your Daily Mix', 'Built from the songs you love', pickSongs(pool, MIX_SIZE, rand), [46, 230, 166], 'you');
    if (m) mixes.push(m);
  }

  // 2. Three era mixes, rotating daily
  const eras = shuffle(ERAS.filter((e) => e.id !== 'all'), rand).slice(0, 3);
  for (const e of eras) {
    const pool = catalog.pool({ kind: 'era', id: e.id });
    const m = buildMix(`mix:era:${e.id}`, `${e.label} Mix`, e.blurb, pickSongs(pool, MIX_SIZE, rand), hashColor('era' + e.id), 'era');
    if (m) mixes.push(m);
  }

  // 3. Two artist mixes from the top 40 artists, rotating daily
  const top = catalog.artistList.slice(0, 40);
  for (const ar of shuffle(top, rand).slice(0, 2)) {
    const short = ar.name.length <= 16 ? ar.name : ar.name.split(/[\s.]+/).filter(Boolean).slice(-1)[0];
    const m = buildMix(`mix:artist:${ar.key}`, `${short} Mix`,
      `${ar.name} and more`, pickSongs(ar.songs, 25, rand), hashColor('ar' + ar.key), 'artist');
    if (m) mixes.push(m);
  }

  // 4. Deep cuts — lesser-played songs across the catalogue
  {
    const pool = catalog.songs.filter((s) => (s.plays || 0) < 50000);
    const m = buildMix('mix:deep', 'Deep Cuts', 'Lesser-heard gems, different every day', pickSongs(pool, MIX_SIZE, rand, () => 1), [155, 89, 182], 'deep');
    if (m) mixes.push(m);
  }

  // 5. Fresh — newest additions / releases
  {
    let pool = catalog.newlyAdded(7);
    if (pool.length < 20) pool = catalog.songs.filter((s) => s.year && s.year >= new Date().getFullYear() - 1);
    const m = buildMix('mix:fresh', 'Fresh Finds', 'New releases & new additions', pickSongs(pool, MIX_SIZE, rand), [245, 166, 35], 'fresh');
    if (m) mixes.push(m);
  }

  store.set(MIX_KEY, { day: DAY, v: catalog.updated, likes: library.likes.size, mixes });
  return mixes;
}

export function mixById(id) {
  return dailyMixes().find((m) => m.id === id) || null;
}

/* ---------- albums of the day ---------- */
export function albumsOfTheDay(filter, n = 12) {
  const rand = rng(`albums:${DAY}:${filterKey(filter)}`);
  const pool = catalog.albumsIn(filter).filter((a) => a.songs.length >= 3);
  const unheard = (a) => a.songs.reduce((c, s) => c + (library.heard.has(s.id) ? 0 : 1), 0) / a.songs.length;
  return weightedPick(pool, n, (a) => Math.pow(a.plays + 100, 0.22) * (0.2 + unheard(a)), rand);
}

/** Artists to feature for a filter, rotating daily among the strongest. */
export function artistsFor(filter, n = 12) {
  const rand = rng(`artists:${DAY}:${filterKey(filter)}`);
  let list = catalog.artistList;
  if (!isAllFilter(filter)) {
    const inPool = new Map();
    for (const s of catalog.pool(filter)) {
      for (const name of splitArtists(s.artist)) {
        const k = mkey(name);
        inPool.set(k, (inPool.get(k) || 0) + 1);
      }
    }
    list = list.filter((a) => (inPool.get(a.key) || 0) >= 4).sort((a, b) => inPool.get(b.key) - inPool.get(a.key));
  }
  return weightedPick(list.slice(0, 40), n, (a) => Math.sqrt(a.songs.length), rand)
    .sort((a, b) => b.songs.length - a.songs.length);
}

/** Radio preview covers for the hero card (stable per day + filter). */
export function heroCovers(filter) {
  const rand = rng(`hero:${DAY}:${filterKey(filter)}`);
  const albums = weightedPick(catalog.albumsIn(filter).filter((a) => a.songs.length >= 3), 3, (a) => Math.pow(a.plays + 100, 0.5), rand);
  return albums.map((a) => a.cover);
}
