# Yadrcha · Telugu Music

*Yadrcha* (యాదృచ్ఛ, "chance") is a mobile-first random player for Telugu film
music, from the 1950s to this week's releases. Tap play and it keeps playing
songs you haven't heard. You can also pick an era or an exact year, open any
film's album, or search.

**Live: https://bsaisuryacharan.github.io/yadrcha/** · install it from the
browser menu ("Add to Home screen") and it runs full-screen like a native app.

## What's inside

- **One-tap random play.** The big button in the middle of the bottom bar
  starts endless random songs (from the era/year picked on Home) and opens
  the player; tap it again to pause or resume.
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
- **Appearance.** Six themes plus Auto (follows the phone's light/dark
  setting): Midnight, AMOLED Black (true black for OLED screens), Nord Dusk,
  Mocha (Catppuccin), Cool White, and Cloud Dancer (Pantone's 2026 Colour of
  the Year, #F0EEE9). Accents: Mint, Ocean, Violet, Rose, Saffron, the theme's
  own, or *Album*, which re-colours the app from each song's cover art and
  morphs between songs. Every accent is re-tuned per theme to keep WCAG AA
  contrast (≥4.5:1). Switching ripples the new theme out from your finger
  (View Transitions API), the phone's status bar follows the theme (and the
  player's tint while it is open), and an inline script in `index.html`
  applies the saved theme before first paint so reloads never flash.
- **Library.** Liked songs, saved albums, followed artists, recently played
  and listening stats. Stored on your device; no account needed.
- **Picks up where you left off.** The current song, position and queue
  survive a reload. Back gestures close the player and sheets instead of
  leaving the app.

## Catalogue

Songs come from **JioSaavn** (full-length streams from its CDN). A daily
GitHub Action (`.github/workflows/refresh-catalog.yml`) runs
`scripts/refresh_catalog.py`, which:

1. **Re-checks existing songs** about once a month (`data/checked.json`): fresh
   play counts, cast (to tell film soundtracks from private albums and
   dubs), language, composer and a freshly decrypted stream URL. Songs
   JioSaavn has removed or relabelled leave the catalogue.
2. Searches JioSaavn with ~110 broad queries, plus a **rotating year sweep**
   (a different slice of film years every day, so each era keeps growing) and
   the **new-releases feed**.
3. Expands the albums behind those hits into full soundtracks, taking
   never-expanded albums first.
4. Keeps Telugu film songs only, decrypts the stream URL, and probes LRCLIB
   for synced lyrics (`scripts/lyrics_probe.py`: exact match, then searches by
   title, first singer and film; a result is accepted only if title and
   duration match). Songs first checked with the old exact-only probe are
   retried, most popular first, up to `MAX_LYRICS` (900) per run. The app also
   does a live lookup with the same checks for songs the build hasn't matched.
5. Runs `scripts/catalog_tools.py` (below) and commits the result.

### Year repair (`scripts/catalog_tools.py`)

JioSaavn's `year` field is often wrong for older films. That is why the old
"2000s" filter played 80s and 90s songs.

- Hundreds of legacy uploads carry a placeholder **2000**
  (`Swati-Mutyam-2000-500x500.jpg` is a 1986 film).
- Songs lifted onto label compilations ("Alanati Suswaralu 2018",
  "Romantic 90's") carry the compilation's year.
- Re-uploads carry the upload year: hundreds of 90s soundtracks were
  re-released in 2013–14 (*Pelli Sandadi* "2014" is 1996, *Rowdy Alludu* is
  1991, *Karna* "2013" is 1995).

Each song is re-dated from its raw JioSaavn year (kept as `yo`, so reruns are
stable). Each album upload is dated as a unit, using this evidence: the same
recording (title + singers) on the film's own album, a sibling song of the
same film with a trustworthy year, **Wikidata** Telugu film release years and
composers (`data/film_years.json`, `data/film_composers.json`, refreshed each
run; titles match across spellings like *Bombai*/*Bombay Priyudu*), the year
in the cover file name, and the singers' active years. Even a year JioSaavn
states plainly is re-opened when Wikidata dates that film years earlier and
the singers agree. Singers and composers rule out namesakes: a Chakri song
can't belong to the 1953 *Devadasu*, and a Keeravani song isn't from a 2021
*Varanasi* by another composer. A film is never moved to a year after
JioSaavn already had its songs. The few cases this can't settle (JioSaavn
merging two films under one name) are pinned in `data/year_overrides.json`.

The same step also:

- Rescues `Song (From "Film")` compilation copies onto their real film and
  merges duplicates.
- Keeps the collection to songs people actually play. Popularity bars rise
  with the era, because streaming counts do: a song needs 10k plays
  (before 1990), 25k (1990s) or 50k (2000 on), and its film's biggest song
  needs 25k / 100k / 250k, or the whole film is too obscure. This and last
  year's releases get 10k / 50k while they catch up. `MIN_PLAYS` scales the
  bars (0 disables them).
- Dubbed films (a "(Telugu)" release Wikidata doesn't know as a Telugu film,
  or a cast led by a Tamil, Hindi, Kannada or Malayalam star) and albums
  JioSaavn lists without a cast stay only if they were big hits (a 1M-play
  song): *Bharateeyudu* and *Aparichithudu* stay, minor dubs and private
  albums go. A film Wikidata knows as Telugu is never treated as a dub.
- Drops what isn't a film song: label compilations, artist showcases,
  standalone singles, devotional and hymn albums,
  background scores and BGM themes, music bits, teasers, speeches, tracks
  under 90 seconds, dialogue tracks, instrumental covers and other-language
  versions.
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
src/theme.js          themes, accent tuning (WCAG contrast), theme-switch animation
src/library.js        likes, saved albums, followed artists, history, "heard" memory (localStorage)
src/lyrics.js         lyrics shards + live LRCLIB fallback
src/ui/pages.js       Home, Search, Explore, Library, Album, Artist, Era/Year, Mix, Liked, Recent
src/ui/nowplaying.js  mini player, full player, lyrics view, queue
src/ui/components.js  rows, cards, song menu, era chips, year picker, sleep timer
src/ui/appearance.js  Appearance sheet: theme previews + accent swatches
src/ui/overlay.js     bottom sheets + back-gesture handling
```

**Icons** are a subset of Material Symbols Rounded. To use a new icon, add its
name to `assets/fonts/symbols.txt` (alphabetical) and run
`scripts/update_icons.sh`.

## Worker (optional)

`worker/` is a Cloudflare Worker that proxies JioSaavn search and playback for
the "Search all of JioSaavn" fallback. See `worker/README.md`.
