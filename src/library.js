// Everything personal, persisted in localStorage: likes, saved albums,
// followed artists, play history, and the "already heard" memory that
// powers no-repeat shuffle.

import { store } from './util.js';

const K = {
  likes: 'yadrcha.likes',              // legacy key kept so old likes survive
  albums: 'yadrcha.albums.v1',
  artists: 'yadrcha.artists.v1',
  history: 'yadrcha.recent.v2',
  heard: 'yadrcha.heard.v1',           // legacy key kept
  searches: 'yadrcha.searches.v1',
  prefs: 'yadrcha.prefs.v1',
  stats: 'yadrcha.stats.v1',
};

const listeners = new Set();
const emit = (what) => listeners.forEach((fn) => fn(what));

function loadHeard() {
  const raw = store.get(K.heard, []);
  // v1 stored a bare id array; v2 stores [[id, dayNumber], …].
  const m = new Map();
  const today = dayNum();
  for (const e of raw) {
    if (Array.isArray(e)) m.set(e[0], e[1]);
    else if (typeof e === 'string') m.set(e, today - 1);
  }
  return m;
}
const dayNum = (d = Date.now()) => Math.floor(d / 86400000);

export const library = {
  likes: new Map(store.get(K.likes, []).map((e) => (Array.isArray(e) ? e : [e, 0]))), // id -> likedAt
  albums: new Map(store.get(K.albums, [])),     // albumId -> savedAt
  artists: new Map(store.get(K.artists, [])),   // artistKey -> followedAt
  history: store.get(K.history, []),            // [{t:'song'|'album'|..., id, at}] newest first
  heard: loadHeard(),                           // songId -> day heard
  searches: store.get(K.searches, []),
  prefs: Object.assign({ filter: { kind: 'era', id: 'all' }, repeat: 'off', shuffle: false }, store.get(K.prefs, {})),
  stats: Object.assign({ plays: 0, seconds: 0, firstDay: dayNum() }, store.get(K.stats, {})),

  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /* likes */
  isLiked(id) { return this.likes.has(id); },
  toggleLike(id) {
    if (this.likes.has(id)) this.likes.delete(id); else this.likes.set(id, Date.now());
    store.set(K.likes, [...this.likes.entries()]);
    emit('likes');
    return this.likes.has(id);
  },
  likedIds() { return [...this.likes.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]); },

  /* saved albums / followed artists */
  isSaved(albumId) { return this.albums.has(albumId); },
  toggleAlbum(albumId) {
    if (this.albums.has(albumId)) this.albums.delete(albumId); else this.albums.set(albumId, Date.now());
    store.set(K.albums, [...this.albums.entries()]);
    emit('albums');
    return this.albums.has(albumId);
  },
  isFollowing(key) { return this.artists.has(key); },
  toggleArtist(key) {
    if (this.artists.has(key)) this.artists.delete(key); else this.artists.set(key, Date.now());
    store.set(K.artists, [...this.artists.entries()]);
    emit('artists');
    return this.artists.has(key);
  },

  /* history of contexts (albums, mixes, radio…) and songs */
  pushHistory(entry) {
    const key = entry.t + ':' + entry.id;
    this.history = [{ ...entry, at: Date.now() }, ...this.history.filter((e) => e.t + ':' + e.id !== key)].slice(0, 120);
    store.set(K.history, this.history);
    emit('history');
  },
  recentSongs(n = 50) { return this.history.filter((e) => e.t === 'song').slice(0, n).map((e) => e.id); },
  recentContexts(n = 8) { return this.history.filter((e) => e.t !== 'song').slice(0, n); },

  /* heard memory — songs served before, with the day they were served */
  markHeard(id) {
    this.heard.set(id, dayNum());
    this.stats.plays++;
    this._saveHeardSoon();
  },
  _saveHeardSoon() {
    clearTimeout(this._ht);
    this._ht = setTimeout(() => {
      store.set(K.heard, [...this.heard.entries()]);
      store.set(K.stats, this.stats);
    }, 800);
  },
  addListenSeconds(sec) {
    this.stats.seconds += sec;
    this._saveHeardSoon();
  },
  forgetHeard(ids) {
    for (const id of ids) this.heard.delete(id);
    this._saveHeardSoon();
  },
  heardToday() {
    const d = dayNum();
    let n = 0;
    for (const v of this.heard.values()) if (v === d) n++;
    return n;
  },

  /* recent searches */
  addSearch(q) {
    q = q.trim();
    if (q.length < 2) return;
    this.searches = [q, ...this.searches.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    store.set(K.searches, this.searches);
  },
  clearSearches() { this.searches = []; store.set(K.searches, []); },

  setPref(k, v) {
    this.prefs[k] = v;
    store.set(K.prefs, this.prefs);
    emit('prefs');
  },
};
