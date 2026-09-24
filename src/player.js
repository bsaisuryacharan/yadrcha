// Playback engine: one <audio>, a play context (album, mix, artist, liked
// songs, or endless radio), a user queue ("Play next" / "Add to queue"),
// shuffle + repeat, lock-screen controls, and session restore.

import { catalog, eraOfYear, filterLabel, isAllFilter } from './catalog.js';
import { library } from './library.js';
import { pickRadio } from './engine.js';
import { shuffle, store, toast } from './util.js';

const SESSION_KEY = 'yadrcha.session.v2';
const RADIO_BUFFER = 6;

const listeners = new Map();
const emit = (ev, data) => (listeners.get(ev) || []).forEach((fn) => fn(data));

export const player = {
  audio: null,
  current: null,
  ctx: null,          // { type, id, title, filter?, ids? }
  order: [],          // song ids in play order for finite contexts
  pos: -1,
  userQueue: [],      // songs queued by the user, played before the context continues
  radioBuffer: [],    // upcoming radio songs
  back: [],           // songs played before (for "previous" in radio)
  errors: 0,
  loading: false,
  sleepAt: 0,         // epoch ms to pause at (0 = off)
  sleepEndOfTrack: false,

  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, []);
    listeners.get(ev).push(fn);
  },

  get playing() { return !!this.audio && !this.audio.paused; },
  get shuffle() { return !!library.prefs.shuffle; },
  get repeat() { return library.prefs.repeat || 'off'; },
  get isRadio() { return this.ctx?.type === 'radio'; },

  init(audio) {
    this.audio = audio;
    let lastT = 0;
    audio.addEventListener('play', () => emit('state'));
    audio.addEventListener('pause', () => { emit('state'); this.saveSession(); });
    audio.addEventListener('playing', () => { this.loading = false; this.errors = 0; emit('state'); });
    audio.addEventListener('waiting', () => { this.loading = true; emit('state'); });
    audio.addEventListener('canplay', () => { if (this.loading) { this.loading = false; emit('state'); } });
    audio.addEventListener('ended', () => {
      if (this.sleepEndOfTrack) { this.setSleep(null); toast('Sleep timer — goodnight 🌙'); return; }
      this.next({ auto: true });
    });
    audio.addEventListener('timeupdate', () => {
      emit('time');
      const t = audio.currentTime;
      if (t > lastT && t - lastT < 2) library.addListenSeconds(t - lastT);
      lastT = t;
      this._positionState();
      if (Math.floor(t) % 10 === 0) this.saveSession();
      if (this.sleepAt && Date.now() >= this.sleepAt) {
        this.setSleep(null);
        audio.pause();
        toast('Sleep timer — goodnight 🌙');
      }
    });
    audio.addEventListener('loadedmetadata', () => { lastT = audio.currentTime; emit('time'); });
    audio.addEventListener('error', () => {
      if (!this.current || !audio.getAttribute('src')) return;
      this.loading = false;
      this.errors++;
      if (this.errors >= 4) {
        emit('state');
        toast('Can’t reach the music server right now — check your connection');
        return;
      }
      toast(`Couldn’t play “${this.current.title}” — skipping`);
      setTimeout(() => this.next({ auto: true, skipError: true }), 400);
    });
    this._mediaSession();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveSession(); });
  },

  /* ---------- starting playback ---------- */

  /** Play a finite list (album, mix, artist, liked…). */
  playList(ctx, ids, startId = null, { shuffle: shuf } = {}) {
    ids = ids.filter((id) => catalog.byId.has(id));
    if (!ids.length) return;
    if (shuf != null && shuf !== this.shuffle) library.setPref('shuffle', shuf);
    this.ctx = { ...ctx, ids };
    this.radioBuffer = [];
    this.pos = this._buildOrder(startId);
    library.pushHistory({ t: ctx.type, id: ctx.id, title: ctx.title });
    this._load(catalog.byId.get(this.order[this.pos]), true);
    emit('queue');
  },

  /** Endless radio within an era/year filter. */
  playRadio(filter, { startSong = null, title } = {}) {
    this.ctx = {
      type: 'radio', id: 'radio:' + (filter?.kind === 'year' ? filter.year : filter?.id || 'all'),
      title: title || (isAllFilter(filter) ? 'Yadrcha Radio' : `${filterLabel(filter)} Radio`), filter,
    };
    this.order = []; this.pos = -1;
    this.radioBuffer = [];
    library.pushHistory({ t: 'radio', id: this.ctx.id, title: this.ctx.title, filter });
    const first = startSong || this._radioPick();
    if (!first) { toast('No songs in this era yet'); return; }
    this._load(first, true);
    this._refillRadio();
    emit('queue');
  },

  /** Play a single song (from search etc.) then continue with radio of its era. */
  playSong(song, { ctx } = {}) {
    if (ctx) return this.playList(ctx, ctx.ids, song.id);
    const era = eraOfYear(song.year);
    this.playRadio(era ? { kind: 'era', id: era.id } : { kind: 'era', id: 'all' },
      { startSong: song, title: `${song.title} Radio` });
  },

  /** Rebuild play order; returns the position of startId (or 0). */
  _buildOrder(startId) {
    const ids = this.ctx.ids;
    if (this.shuffle) {
      const rest = shuffle(ids.filter((id) => id !== startId));
      this.order = startId ? [startId, ...rest] : rest;
      return 0;
    }
    this.order = ids.slice();
    return startId ? Math.max(0, ids.indexOf(startId)) : 0;
  },

  /* ---------- transport ---------- */

  toggle() {
    if (!this.current) return;
    const a = this.audio;
    if (!a.getAttribute('src') || a.error) {
      // Restored session (mobile only allows playback from a gesture, so
      // the source is attached on first play) or recovering from an error.
      const t = this._pendingTime || a.currentTime || 0;
      this._pendingTime = 0;
      this.errors = 0;
      this._load(this.current, true, { keepTime: true, startAt: t });
      return;
    }
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  },

  next({ auto = false, skipError = false } = {}) {
    if (!this.current) return;
    if (auto && !skipError && this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
      return;
    }
    this.back.push(this.current.id);
    if (this.back.length > 200) this.back.shift();

    let song = null;
    if (this.userQueue.length) {
      song = this.userQueue.shift();
    } else if (this.isRadio) {
      // A one-song pick has nothing else to play: replay it.
      song = this.radioBuffer.shift() || this._radioPick() || this.current;
      this._refillRadio();
    } else if (this.ctx) {
      if (this.pos + 1 < this.order.length) {
        this.pos++;
        song = catalog.byId.get(this.order[this.pos]);
      } else if (this.repeat === 'all') {
        this.pos = this._buildOrder(null);
        song = catalog.byId.get(this.order[this.pos]);
      } else {
        // End of an album/mix: keep the music going with radio from the same era.
        const era = eraOfYear(this.current.year);
        const filter = era ? { kind: 'era', id: era.id } : { kind: 'era', id: 'all' };
        const from = this.ctx.title;
        this.ctx = { type: 'radio', id: 'radio:' + filter.id, title: `${filterLabel(filter)} Radio`, filter, autoplayFrom: from };
        song = this._radioPick();
        this._refillRadio();
        toast(`Finished ${from} — continuing with ${filterLabel(filter)} radio`);
      }
    }
    if (song) this._load(song, true);
    emit('queue');
  },

  prev() {
    if (!this.current) return;
    if (this.audio.currentTime > 4) { this.audio.currentTime = 0; return; }
    if (!this.isRadio && this.ctx && this.order[this.pos] && this.order[this.pos] !== this.current.id) {
      // A queued song was playing: step back into the context where we left it.
      this._load(catalog.byId.get(this.order[this.pos]), true);
    } else if (!this.isRadio && this.ctx && this.pos > 0) {
      this.pos--;
      this._load(catalog.byId.get(this.order[this.pos]), true);
    } else if (this.back.length) {
      const id = this.back.pop();
      const s = catalog.byId.get(id);
      if (!s) return;
      if (this.isRadio) this.radioBuffer.unshift(this.current);
      else if (this.ctx) {
        const i = this.order.indexOf(id);
        if (i >= 0) this.pos = i;
      }
      this._load(s, true);
    } else {
      this.audio.currentTime = 0;
    }
    emit('queue');
  },

  seek(t) {
    if (!this.audio || !isFinite(t)) return;
    this.audio.currentTime = Math.max(0, Math.min(t, (this.audio.duration || this.current?.duration || t)));
    emit('time');
  },

  /** Jump to an item shown in the queue sheet. */
  jump(kind, index) {
    this.back.push(this.current.id);
    let song;
    if (kind === 'user') {
      song = this.userQueue.splice(index, 1)[0];
    } else if (this.isRadio) {
      song = this.radioBuffer[index];
      this.radioBuffer = this.radioBuffer.slice(index + 1);
      this._refillRadio();
    } else {
      this.pos = this.pos + 1 + index;
      song = catalog.byId.get(this.order[this.pos]);
    }
    if (song) this._load(song, true);
    emit('queue');
  },

  removeFromQueue(kind, index) {
    if (kind === 'user') this.userQueue.splice(index, 1);
    else if (this.isRadio) { this.radioBuffer.splice(index, 1); this._refillRadio(); }
    else this.order.splice(this.pos + 1 + index, 1);
    emit('queue');
  },

  playNext(song) {
    if (!this.current) { this.playSong(song); return; }
    this.userQueue.unshift(song);
    emit('queue');
  },
  addToQueue(song) {
    if (!this.current) { this.playSong(song); return; }
    this.userQueue.push(song);
    emit('queue');
  },

  toggleShuffle() {
    const on = !this.shuffle;
    library.setPref('shuffle', on);
    if (this.ctx && !this.isRadio && this.current) {
      const done = this.order.slice(0, this.pos + 1);
      const rest = this.ctx.ids.filter((id) => !done.includes(id));
      this.order = done.concat(on ? shuffle(rest) : this.ctx.ids.filter((id) => rest.includes(id)));
    }
    emit('mode');
    emit('queue');
    return on;
  },
  cycleRepeat() {
    const next = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    library.setPref('repeat', next);
    emit('mode');
    return next;
  },

  /** minutes → pause after that long; 'track' → pause when this song ends; null → off. */
  setSleep(minutes) {
    this.sleepAt = typeof minutes === 'number' ? Date.now() + minutes * 60000 : 0;
    this.sleepEndOfTrack = minutes === 'track';
    emit('mode');
  },
  sleepLabel() {
    if (this.sleepEndOfTrack) return 'End of song';
    if (!this.sleepAt) return '';
    const m = Math.max(1, Math.ceil((this.sleepAt - Date.now()) / 60000));
    return `${m} min left`;
  },

  /** What plays next: user queue first, then the context. */
  upcoming(limit = 40) {
    const ctxSongs = this.isRadio
      ? this.radioBuffer
      : this.order.slice(this.pos + 1, this.pos + 1 + limit).map((id) => catalog.byId.get(id)).filter(Boolean);
    return { user: this.userQueue.slice(), context: ctxSongs.slice(0, limit) };
  },

  /* ---------- internals ---------- */

  _radioPick() {
    const hard = new Set([...(this.current ? [this.current.id] : []), ...this.radioBuffer.map((s) => s.id), ...this.userQueue.map((s) => s.id)]);
    const soft = new Set(this.back.slice(-50));
    // Songs already lined up count as "recent" too, so the upcoming
    // stretch varies film and singer.
    const recent = this.back.slice(-6).map((id) => catalog.byId.get(id)).filter(Boolean);
    if (this.current) recent.push(this.current);
    recent.push(...this.radioBuffer);
    return pickRadio(this.ctx?.filter, { hard, soft, recent });
  },
  _refillRadio() {
    while (this.radioBuffer.length < RADIO_BUFFER) {
      const s = this._radioPick();
      if (!s || this.radioBuffer.some((x) => x.id === s.id)) break;
      this.radioBuffer.push(s);
      // Mark as served now, so a reload or another radio doesn't re-serve it.
      library.heard.set(s.id, library.heard.get(s.id) ?? Math.floor(Date.now() / 86400000));
    }
    library._saveHeardSoon();
    this._warm();
  },
  _warm() {
    // Pre-fetch the next cover so the swap is instant.
    const nxt = this.userQueue[0] || (this.isRadio ? this.radioBuffer[0] : catalog.byId.get(this.order[this.pos + 1]));
    if (nxt?.cover) { const i = new Image(); i.src = nxt.cover; }
  },

  _load(song, autoplay, { keepTime = false, startAt = 0 } = {}) {
    if (!song) return;
    const a = this.audio;
    this.current = song;
    this.loading = true;
    // Drop any pending resume-seek from a previous load.
    if (this._seekOnce) { a.removeEventListener('loadedmetadata', this._seekOnce); this._seekOnce = null; }
    a.src = song.url;
    if (startAt) {
      this._seekOnce = () => { a.currentTime = startAt; a.removeEventListener('loadedmetadata', this._seekOnce); this._seekOnce = null; };
      a.addEventListener('loadedmetadata', this._seekOnce);
    }
    if (autoplay) a.play().catch(() => { this.loading = false; emit('state'); });
    else this.loading = false;
    if (!keepTime) {
      library.markHeard(song.id);
      library.pushHistory({ t: 'song', id: song.id });
    }
    this._metadata(song);
    this._warm();
    emit('track', song);
    emit('state');
    this.saveSession();
  },

  _metadata(s) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.title,
        artist: s.artist,
        album: s.movie + (s.year ? ` (${s.year})` : ''),
        artwork: [
          { src: s.thumb, sizes: '150x150', type: 'image/jpeg' },
          { src: s.cover, sizes: '500x500', type: 'image/jpeg' },
        ],
      });
    } catch {}
  },
  _mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
    set('play', () => { if (!this.playing) this.toggle(); });
    set('pause', () => { if (this.playing) this.toggle(); });
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => this.seek(d.seekTime));
    set('seekbackward', (d) => this.seek(this.audio.currentTime - (d.seekOffset || 10)));
    set('seekforward', (d) => this.seek(this.audio.currentTime + (d.seekOffset || 10)));
  },
  _positionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.audio.duration;
    if (!isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(d, this.audio.currentTime), playbackRate: 1 });
    } catch {}
  },

  /* ---------- session restore ---------- */
  saveSession() {
    if (!this.current) return;
    const ctx = this.ctx ? { ...this.ctx, ids: this.ctx.ids ? this.ctx.ids.slice(0, 3000) : undefined } : null;
    store.set(SESSION_KEY, {
      song: this.current.id,
      time: Math.floor(this.audio?.currentTime || 0),
      ctx,
      order: this.isRadio ? null : this.order.slice(0, 3000),
      pos: this.pos,
      queue: this.userQueue.map((s) => s.id).slice(0, 50),
      radio: this.radioBuffer.map((s) => s.id),
    });
  },
  restore() {
    const s = store.get(SESSION_KEY, null);
    if (!s) return false;
    const song = catalog.byId.get(s.song);
    if (!song) return false;
    this.ctx = s.ctx || { type: 'radio', id: 'radio:all', title: 'Yadrcha Radio', filter: { kind: 'era', id: 'all' } };
    this.order = (s.order || []).filter((id) => catalog.byId.has(id));
    this.pos = Math.min(s.pos ?? -1, this.order.length - 1);
    if (!this.isRadio && this.order[this.pos] !== song.id) this.pos = this.order.indexOf(song.id);
    this.userQueue = (s.queue || []).map((id) => catalog.byId.get(id)).filter(Boolean);
    this.radioBuffer = (s.radio || []).map((id) => catalog.byId.get(id)).filter(Boolean);
    this.current = song;
    // Don't touch <audio> yet — mobile browsers only allow playback from a
    // gesture, so the source is attached on the first tap of play.
    this._pendingTime = s.time || 0;
    this._metadata(song);
    emit('track', song);
    emit('state');
    emit('queue');
    return true;
  },
};
