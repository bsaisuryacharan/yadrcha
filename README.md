# Yadrcha · Telugu Music

*Yadrcha* (యాదృచ్ఛ, "chance") is a mobile-first random player for Telugu film
music, from the 1950s to this week's releases. Tap play and it keeps playing
songs you haven't heard. You can also pick an era or an exact year, open any
film's album, or search.

**Live: https://bsaisuryacharan.github.io/yadrcha/** · install it from the
browser menu ("Add to Home screen") and it runs full-screen like a native app.

## What's inside

- **Radio that never repeats.** Every song you've heard is remembered on your
  device. Radio only serves new songs until you've heard everything in that
  era, then starts a fresh cycle. Consecutive picks avoid the same film and
  singer, and under "All eras" the classics get a fair share against the much
  larger 2020s catalogue.
- **Eras and exact years.** Chips for Classics, 70s, 80s, 90s, 2000s, 2010s
  and 2020s, plus a year picker (with song counts) for any single year. The
  filter uses each song's corrected film release year (see below), so the
  2000s chip plays 2000–2009 films only.
- **Albums.** Every film soundtrack has its own page: cover, year, length,
  full track list, play or shuffle, save to library, and "More from 1995" /
  "More with SPB" shelves. Playing a track plays the album from that point;
  when the album ends, radio continues from the same era.
- **Fresh every day.** Daily mixes (by era, by singer, Deep Cuts, Fresh Finds,
  and one built from your likes), "Albums for today", new releases, and a
  "Just added" shelf. They're seeded by the date, so they stay stable during
  the day and change the next morning. The catalogue itself grows daily (see
  *Catalogue* below).
- **Now playing.** Mini player with swipe-to-skip, a full-screen player tinted
  to the cover art, a draggable seek bar, shuffle and repeat (all or one),
  **synced lyrics** (tap a line to jump to it), an editable **Up next** queue
  (Play next / Add to queue), a sleep timer, and lock-screen / headphone
  controls via MediaSession.
- **Search** over songs, films and singers, tolerant of Telugu
  transliteration ("Swathi Muthyam" also finds "Swati Mutyam"), with a
  fallback to all of JioSaavn.
- **Library.** Liked songs, saved albums, followed artists, recently played
  and listening stats. Stored on your device; no account needed.
- **Picks up where you left off.** The current song, position and queue
  survive a reload. Back gestures close the player and sheets instead of
  leaving the app.

## Catalogue

Songs come from **JioSaavn** (full-length streams from its CDN). A daily
GitHub Action (`.github/workflows/refresh-catalog.yml`) runs
`scripts/refresh_catalog.py`, which:

1. Searches JioSaavn with ~110 broad queries, plus a **rotating year sweep**
   (a different slice of film years every day, so each era keeps growing) and
   the **new-releases feed**.
2. Expands the albums behind those hits into full soundtracks, taking
   never-expanded albums first.
3. Keeps Telugu film songs only, decrypts the stream URL, and probes LRCLIB
   for synced lyrics.
4. Runs `scripts/catalog_tools.py` (below) and commits the result.

### Year repair (`scripts/catalog_tools.py`)

JioSaavn's `year` field is often wrong for older films. That is why the old
"2000s" filter played 80s and 90s songs.

- Hundreds of legacy uploads carry a placeholder **2000**
  (`Swati-Mutyam-2000-500x500.jpg` is a 1986 film).
- Songs lifted onto label compilations ("Alanati Suswaralu 2018",
  "Romantic 90's") carry the compilation's year.
- Some re-uploads carry the upload year (Karna 2013 is really 1995).

Each song is re-dated from its raw JioSaavn year (kept as `yo`, so reruns are
stable). Each album upload is dated as a unit, using this evidence: a sibling
song of the same film with a trustworthy year, **Wikidata** Telugu film
release years (`data/film_years.json`, refreshed each run), the year in the
cover file name, and the singers' active years. The singers also rule out
same-named remakes: a Chakri song can't belong to the 1953 *Devadasu*.

The same step also:

- Rescues `Song (From "Film")` compilation copies onto their real film and
  merges duplicates.
- Drops label compilations, background scores, OSTs, dialogue tracks,
  instrumental covers and devotional albums.
- Assigns album ids.

Run it by hand with `python scripts/catalog_tools.py`.

### Files

- `catalog.json` holds metadata only: 2.5 MB, about 0.7 MB gzipped, versus
  the previous 16 MB. CDN prefixes are stripped.
- `lyrics/00.json` … `lyrics/63.json` are synced-lyrics shards. The app only
  fetches one when you open lyrics (shard = FNV-1a(song id) % 64).

## Run locally

```
python -m http.server 8000     # then open http://localhost:8000
```

It's a static site: no build step, no framework, no API keys. It is plain ES
modules in `src/`, one stylesheet in `assets/app.css`, and self-hosted fonts.
A service worker (`sw.js`) caches the app so the installed version can open
offline (playback still needs a connection).

```
index.html            app shell
src/app.js            boot + hash router (#/album/…, #/artist/…, #/era/…, #/year/…, #/mix/…)
src/catalog.js        catalogue loading, albums/artists/years indexes, search
src/engine.js         no-repeat radio picks, daily mixes, albums of the day
src/player.js         playback engine: contexts, queue, shuffle/repeat, sleep timer, MediaSession, session restore
src/library.js        likes, saved albums, followed artists, history, "heard" memory (localStorage)
src/lyrics.js         lyrics shards + live LRCLIB fallback
src/ui/pages.js       Home, Search, Library, Album, Artist, Era/Year, Mix, Liked, Recent
src/ui/nowplaying.js  mini player, full player, lyrics view, queue
src/ui/components.js  rows, cards, song menu, era chips, year picker, sleep timer
src/ui/overlay.js     bottom sheets + back-gesture handling
```

**Icons** are a subset of Material Symbols Rounded. To use a new icon, add its
name to `assets/fonts/symbols.txt` (alphabetical) and run
`scripts/update_icons.sh`.

## Worker (optional)

`worker/` is a Cloudflare Worker that proxies JioSaavn search and playback for
the "Search all of JioSaavn" fallback. See `worker/README.md`.
