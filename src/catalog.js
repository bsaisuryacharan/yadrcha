// Catalog: loads catalog.json once and builds the in-memory indexes the
// whole app runs on — songs, albums (film soundtracks), artists, years.

const NOW = new Date().getFullYear();

export const ERAS = [
  { id: 'all', label: 'All eras', short: 'All', from: 0, to: 9999 },
  { id: 'classics', label: 'Classics', short: 'Classics', from: 1930, to: 1969, blurb: 'Ghantasala, Susheela & the golden age' },
  { id: '70s', label: '70s', short: '70s', from: 1970, to: 1979, blurb: 'Melodies of the seventies' },
  { id: '80s', label: '80s', short: '80s', from: 1980, to: 1989, blurb: 'Ilaiyaraaja, SPB & Janaki' },
  { id: '90s', label: '90s', short: '90s', from: 1990, to: 1999, blurb: 'Keeravani, Koti & the cassette era' },
  { id: '2000s', label: '2000s', short: '2000s', from: 2000, to: 2009, blurb: 'Mani Sharma, DSP & RP Patnaik' },
  { id: '2010s', label: '2010s', short: '2010s', from: 2010, to: 2019, blurb: 'Thaman, DSP & Mickey J Meyer' },
  { id: '2020s', label: '2020s', short: '2020s', from: 2020, to: 9999, blurb: 'Today’s chartbusters' },
];
export const eraById = (id) => ERAS.find((e) => e.id === id) || ERAS[0];
export function eraOfYear(y) {
  if (!y) return null;
  return ERAS.find((e) => e.id !== 'all' && y >= e.from && y <= e.to) || null;
}

/** A filter is { kind: 'era', id } or { kind: 'year', year }. */
export function filterLabel(f) {
  if (!f || (f.kind === 'era' && f.id === 'all')) return 'All eras';
  return f.kind === 'year' ? String(f.year) : eraById(f.id).label;
}
export function filterRange(f) {
  if (!f) return [0, 9999];
  if (f.kind === 'year') return [f.year, f.year];
  const e = eraById(f.id);
  return [e.from, e.to];
}
export const filterKey = (f) => (f?.kind === 'year' ? `y${f.year}` : `e${f?.id || 'all'}`);
export const isAllFilter = (f) => !f || (f.kind === 'era' && f.id === 'all');

/* ---------- loose phonetic key (mirrors scripts/catalog_tools.py mkey) ---------- */
const DIGRAPHS = [['th', 't'], ['dh', 'd'], ['bh', 'b'], ['kh', 'k'], ['gh', 'g'], ['ph', 'f'], ['sh', 's'],
  ['ch', 'c'], ['jh', 'j'], ['ee', 'i'], ['oo', 'u'], ['w', 'v'], ['z', 'j'], ['q', 'k'], ['x', 'ks']];
export function mkey(s) {
  s = String(s || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]/g, '');
  for (const [a, b] of DIGRAPHS) s = s.split(a).join(b);
  return s.replace(/h/g, '').replace(/(.)\1+/g, '$1');
}
export const splitArtists = (a) => String(a || '').split(/\s*(?:,|&|\band\b)\s*/).map((x) => x.trim()).filter(Boolean);

const NON_FILM = /\b(background\s*score|bgm|theme\s*music|original\s*score|instrumental|interlude|dialogues?)\b/i;

export const catalog = {
  songs: [],
  byId: new Map(),
  albums: new Map(),     // id -> album
  albumList: [],
  artists: new Map(),    // key -> artist
  artistList: [],
  years: new Map(),      // year -> song count
  updated: null,
  newestAdded: null,
  ready: false,

  async load() {
    const res = await fetch('catalog.json');
    if (!res.ok) throw new Error('catalog ' + res.status);
    const data = await res.json();
    this.build(data);
    return this;
  },

  build(data) {
    const pu = data.prefix?.u || 'https://aac.saavncdn.com/';
    const pc = data.prefix?.c || 'https://c.saavncdn.com/';
    const full = (u, p) => (!u ? '' : u.startsWith('http') ? u : p + u);
    this.updated = data.updated || null;
    this.shards = data.shards || 64;
    const songs = [];
    for (const r of data.songs || []) {
      if (!r.i || !r.u || !r.t) continue;
      if (NON_FILM.test(r.t) || NON_FILM.test(r.m)) continue;
      const cover = full(r.c, pc);
      songs.push({
        id: r.i,
        title: r.t,
        artist: r.a || 'Unknown',
        movie: r.m || 'Single',
        music: r.md || '',
        url: full(r.u, pu),
        cover,
        thumb: cover.replace(/500x500/, '150x150'),
        year: r.y || null,
        duration: r.d || 0,
        plays: r.p || 0,
        albumId: r.b || 'm' + mkey(r.m) + (r.y || ''),
        hasLyrics: !!(r.l || r.lr),
        lyricsInline: r.lr || null,
        noLyrics: !!r.nl,
        added: r.ad || null,
      });
    }
    this.songs = songs;
    this.byId = new Map(songs.map((s) => [s.id, s]));

    // Albums
    const albums = new Map();
    for (const s of songs) {
      let a = albums.get(s.albumId);
      if (!a) {
        a = { id: s.albumId, name: s.movie, year: s.year, songs: [], plays: 0, covers: new Map(), added: null, music: '' };
        albums.set(s.albumId, a);
      }
      a.songs.push(s);
      a.plays += s.plays;
      a.covers.set(s.cover, (a.covers.get(s.cover) || 0) + 1 + s.plays / 1e7);
      if (s.added && (!a.added || s.added > a.added)) a.added = s.added;
      if (s.music && !a.music) a.music = s.music;
    }
    for (const a of albums.values()) {
      a.cover = [...a.covers.entries()].sort((x, y) => y[1] - x[1])[0][0];
      a.thumb = a.cover.replace(/500x500/, '150x150');
      delete a.covers;
      a.songs.sort((x, y) => y.plays - x.plays || x.title.localeCompare(y.title));
      a.duration = a.songs.reduce((t, s) => t + (s.duration || 0), 0);
      const counts = new Map();
      for (const s of a.songs) for (const n of splitArtists(s.artist)) counts.set(n, (counts.get(n) || 0) + 1);
      a.artists = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n);
    }
    this.albums = albums;
    this.albumList = [...albums.values()];

    // Artists (singers + music directors)
    const artists = new Map();
    const addArtist = (name, s, role) => {
      const key = mkey(name);
      if (key.length < 3 || /^(various|unknown)/.test(key)) return;
      let ar = artists.get(key);
      if (!ar) { ar = { key, names: new Map(), songs: [], albumIds: new Set(), plays: 0, roles: new Set() }; artists.set(key, ar); }
      ar.names.set(name, (ar.names.get(name) || 0) + 1);
      if (!ar.songs.includes(s)) { ar.songs.push(s); ar.plays += s.plays; }
      ar.albumIds.add(s.albumId);
      ar.roles.add(role);
    };
    for (const s of songs) {
      for (const n of splitArtists(s.artist)) addArtist(n, s, 'singer');
      for (const n of splitArtists(s.music)) addArtist(n, s, 'composer');
    }
    for (const ar of artists.values()) {
      ar.name = [...ar.names.entries()].sort((x, y) => y[1] - x[1])[0][0];
      delete ar.names;
      ar.songs.sort((x, y) => y.plays - x.plays);
      const top = ar.songs.find((s) => s.cover) || ar.songs[0];
      ar.cover = top?.cover || '';
      const ys = ar.songs.map((s) => s.year).filter(Boolean).sort((x, y) => x - y);
      ar.span = ys.length ? [ys[Math.floor(ys.length * 0.1)], ys[Math.floor(ys.length * 0.9)]] : null;
    }
    this.artists = artists;
    this.artistList = [...artists.values()].filter((a) => a.songs.length >= 4).sort((x, y) => y.songs.length - x.songs.length);

    // Years
    const years = new Map();
    for (const s of songs) if (s.year) years.set(s.year, (years.get(s.year) || 0) + 1);
    this.years = years;
    this.newestAdded = songs.reduce((m, s) => (s.added && (!m || s.added > m) ? s.added : m), null);
    this.ready = true;
  },

  artistKeyOf(name) { return mkey(name); },
  artistsOfSong(s) {
    return splitArtists(s.artist).map((n) => this.artists.get(mkey(n))).filter(Boolean);
  },

  /** Songs matching a filter (unknown-year songs only appear under All). */
  pool(f) {
    if (isAllFilter(f)) return this.songs;
    const [a, b] = filterRange(f);
    return this.songs.filter((s) => s.year && s.year >= a && s.year <= b);
  },
  albumsIn(f) {
    if (isAllFilter(f)) return this.albumList;
    const [a, b] = filterRange(f);
    return this.albumList.filter((al) => al.year && al.year >= a && al.year <= b);
  },
  count(f) {
    if (isAllFilter(f)) return this.songs.length;
    const [a, b] = filterRange(f);
    let n = 0;
    for (const [y, c] of this.years) if (y >= a && y <= b) n += c;
    return n;
  },
  latestAlbums(n = 20) {
    return this.albumList
      .filter((a) => a.year && a.year >= NOW - 1)
      .sort((x, y) => (y.year - x.year) || ((y.added || '') > (x.added || '') ? 1 : -1) || y.plays - x.plays)
      .slice(0, n);
  },
  newlyAdded(days = 7) {
    if (!this.newestAdded) return [];
    const cutoff = new Date(this.newestAdded);
    cutoff.setDate(cutoff.getDate() - days);
    const c = cutoff.toISOString().slice(0, 10);
    return this.songs.filter((s) => s.added && s.added >= c);
  },

  /* ---------- search ---------- */
  search(q, limit = 40) {
    const raw = q.trim().toLowerCase();
    if (raw.length < 2) return { songs: [], albums: [], artists: [], top: null };
    const k = mkey(raw);
    const words = raw.split(/\s+/).filter(Boolean);
    const scoreText = (text, tk) => {
      const t = text.toLowerCase();
      if (t === raw) return 100;
      if (t.startsWith(raw)) return 80;
      if (t.includes(raw)) return 60;
      tk = tk ?? mkey(t);
      if (k.length >= 3 && tk.startsWith(k)) return 55;
      if (k.length >= 3 && tk.includes(k)) return 40;
      if (words.length > 1 && words.every((w) => t.includes(w))) return 35;
      return 0;
    };
    const pop = (p) => Math.log10((p || 0) + 10);

    const songs = [];
    for (const s of this.songs) {
      const kk = s._k || (s._k = [mkey(s.title), mkey(s.movie), mkey(s.artist)]);
      const st = scoreText(s.title, kk[0]), sm = scoreText(s.movie, kk[1]) * 0.7, sa = scoreText(s.artist, kk[2]) * 0.5;
      const sc = Math.max(st, sm, sa);
      if (sc > 0) songs.push([sc + pop(s.plays) * 2, s]);
    }
    songs.sort((a, b) => b[0] - a[0]);

    const albums = [];
    for (const a of this.albumList) {
      const sc = scoreText(a.name, a._k || (a._k = mkey(a.name)));
      if (sc > 0) albums.push([sc + pop(a.plays) * 2, a]);
    }
    albums.sort((a, b) => b[0] - a[0]);

    const artists = [];
    for (const ar of this.artists.values()) {
      if (ar.songs.length < 2) continue;
      const sc = scoreText(ar.name, ar.key);
      if (sc > 0) artists.push([sc + Math.log10(ar.songs.length + 1) * 6, ar]);
    }
    artists.sort((a, b) => b[0] - a[0]);

    const cands = [
      songs[0] && { kind: 'song', score: songs[0][0], item: songs[0][1] },
      albums[0] && { kind: 'album', score: albums[0][0] + 4, item: albums[0][1] },
      artists[0] && { kind: 'artist', score: artists[0][0] + 6, item: artists[0][1] },
    ].filter(Boolean).sort((a, b) => b.score - a.score);

    return {
      top: cands[0] || null,
      songs: songs.slice(0, limit).map((x) => x[1]),
      albums: albums.slice(0, 16).map((x) => x[1]),
      artists: artists.slice(0, 12).map((x) => x[1]),
    };
  },
};
