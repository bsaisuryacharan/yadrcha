#!/usr/bin/env python3
"""
Refresh catalog.json with Telugu film songs.

Source flow:
  1. iTunes Search API gives us authoritative metadata: trackId, title,
     artist, movie (collectionName), 1000x1000 movie poster, release year.
  2. yt-dlp searches YouTube for each song and stores the matching
     videoId. Frontend uses that for full-length audio playback.

The catalog grows over time. New iTunes results are merged in. Songs
without a YouTube videoId are looked up (capped per run by MAX_LOOKUPS
so the workflow stays under its time budget).

Year tagging is taken straight from iTunes' releaseDate field — it's
the soundtrack release date, which equals the movie release in nearly
every case for Telugu film music. The "movie" displayed in the app is
collectionName with the "(Original Motion Picture Soundtrack)" suffix
trimmed off.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

try:
    import requests
except ImportError:
    sys.exit("Install requests: pip install requests")

# ---------- Config ----------

# Diverse query set covering composers, singers, era keywords, and famous
# movies. iTunes returns up to 200 per query; after dedupe we typically
# get 1500-3000 unique tracks across all of these.
QUERIES = [
    # Composers / music directors
    'ilaiyaraaja telugu', 'ar rahman telugu', 'devi sri prasad', 'thaman s telugu',
    'anirudh telugu', 'mickey j meyer', 'harris jayaraj telugu', 'vidyasagar telugu',
    'koti telugu', 'raj koti', 'm m keeravani', 'ramana gogula',
    'mani sharma telugu', 'chakri telugu', 'rp patnaik', 'sunny m r',
    # Singers
    'ghantasala telugu', 'spb telugu', 'sid sriram telugu', 'shreya ghoshal telugu',
    'kk telugu', 'sonu nigam telugu', 'javed ali telugu', 'chinmayi telugu',
    'sunitha telugu', 'armaan malik telugu', 'karthik telugu', 'haricharan telugu',
    'mangli telugu', 'nakash aziz telugu', 'kailash kher telugu', 'arijit singh telugu',
    # Famous movies
    'pushpa telugu', 'baahubali', 'rrr telugu', 'magadheera', 'eega telugu',
    'arjun reddy', 'jersey telugu', 'fidaa telugu', 'ala vaikunthapurramuloo',
    'sarrainodu', 'saaho', 'athadu telugu', 'okkadu telugu', 'pokiri telugu',
    'khaidi telugu', 'sye raa', 'maharshi telugu', 'kushi telugu',
    'arjuna phalguna', 'salaar telugu', 'guntur kaaram', 'devara telugu',
    'kalki 2898', 'hi nanna telugu', 'mr bachchan',
    # Generic / era
    'telugu hits', 'tollywood songs', 'telugu romantic', 'telugu folk',
    'telugu old songs', 'telugu super hit', 'telugu melody', 'telugu dance',
    'telugu 1970', 'telugu 1980', 'telugu 1990', 'telugu 2000',
    'telugu 2010', 'telugu 2015', 'telugu 2020', 'telugu 2024',
    'telugu mass songs', 'telugu duet', 'telugu sad songs',
]

CATALOG_PATH = Path('catalog.json')
MAX_LOOKUPS = int(os.environ.get('MAX_LOOKUPS', '300'))

# ---------- iTunes ----------

def itunes_search(query: str) -> list[dict]:
    url = (
        'https://itunes.apple.com/search?'
        + urllib.parse.urlencode({
            'term': query,
            'media': 'music',
            'entity': 'song',
            'limit': 200,
            'country': 'in',
        })
    )
    try:
        r = requests.get(url, timeout=20, headers={'User-Agent': 'yadrcha-catalog/1.0'})
        r.raise_for_status()
        return r.json().get('results', [])
    except Exception as e:
        print(f'  ! iTunes fetch failed for {query!r}: {e}', file=sys.stderr)
        return []


def clean_movie(coll: str) -> str:
    """Strip iTunes packaging suffixes from collection (movie) name."""
    if not coll:
        return ''
    s = coll
    s = re.sub(r'\s*\([^)]*soundtrack[^)]*\)\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*\([^)]*original score[^)]*\)\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*\(\s*from\s+[^)]+\)\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*-\s*single\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s*-\s*ep\s*$', '', s, flags=re.IGNORECASE)
    return s.strip()


def normalize(track: dict) -> dict | None:
    if not track or not track.get('previewUrl'):
        return None
    if track.get('primaryGenreName') != 'Telugu':
        return None
    rd = track.get('releaseDate') or ''
    try:
        year = int(rd[:4]) if rd else None
    except ValueError:
        year = None
    art100 = track.get('artworkUrl100') or ''
    art_hd = art100.replace('/100x100bb.', '/1000x1000bb.')
    return {
        'i': track['trackId'],
        't': (track.get('trackName') or '').strip(),
        'a': (track.get('artistName') or '').strip(),
        'm': clean_movie(track.get('collectionName') or ''),
        'u': track['previewUrl'],
        'c': art_hd,
        'y': year,
        'd': int((track.get('trackTimeMillis') or 30000) / 1000),
    }


# ---------- yt-dlp YouTube search ----------

def yt_search(song: dict) -> str | None:
    """Find a YouTube videoId for a song. Returns 11-char ID or None."""
    title = song.get('t') or ''
    artist = song.get('a') or ''
    movie = song.get('m') or ''

    queries = [
        f'{title} {movie} telugu song',
        f'{title} {movie}',
        f'{title} {artist} telugu',
        f'{title} {artist}',
    ]

    for q in queries:
        try:
            r = subprocess.run(
                [
                    'yt-dlp',
                    f'ytsearch1:{q}',
                    '--get-id',
                    '--skip-download',
                    '--no-warnings',
                    '--socket-timeout', '15',
                    '--no-playlist',
                ],
                capture_output=True,
                text=True,
                timeout=35,
            )
            vid = r.stdout.strip().splitlines()[0] if r.stdout.strip() else ''
            if len(vid) == 11 and re.match(r'^[\w-]+$', vid):
                return vid
        except subprocess.TimeoutExpired:
            print(f'  ! yt-dlp timeout for {title!r}', file=sys.stderr)
            continue
        except Exception as e:
            print(f'  ! yt-dlp error for {title!r}: {e}', file=sys.stderr)
            continue
    return None


# ---------- Main ----------

def load_catalog() -> dict:
    if CATALOG_PATH.exists():
        try:
            with CATALOG_PATH.open('r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f'! Could not load existing catalog: {e}', file=sys.stderr)
    return {'version': 1, 'songs': []}


def save_catalog(cat: dict) -> None:
    cat['updated'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    with CATALOG_PATH.open('w', encoding='utf-8') as f:
        json.dump(cat, f, separators=(',', ':'), ensure_ascii=False)


def main() -> int:
    print('=== Yadrcha catalog refresh ===')
    cat = load_catalog()
    by_id: dict[int, dict] = {s['i']: s for s in cat.get('songs', [])}
    print(f'Loaded {len(by_id)} existing songs')

    # 1. Fetch all iTunes queries; merge new metadata
    new_count = 0
    for i, q in enumerate(QUERIES, 1):
        print(f'[iTunes {i}/{len(QUERIES)}] {q}')
        for r in itunes_search(q):
            n = normalize(r)
            if not n:
                continue
            existing = by_id.get(n['i'])
            if existing:
                # Refresh metadata (preserve yt id) — handles iTunes
                # corrections to title/year/movie over time.
                yt = existing.get('yt')
                bad = existing.get('bad')
                existing.update(n)
                if yt:
                    existing['yt'] = yt
                if bad:
                    existing['bad'] = bad
            else:
                by_id[n['i']] = n
                new_count += 1
        time.sleep(0.4)

    print(f'Added {new_count} new songs via iTunes')

    # 2. yt-dlp lookups for songs missing yt id (priority: new songs first)
    todo: list[dict] = []
    for s in by_id.values():
        if 'yt' not in s and not s.get('bad'):
            todo.append(s)

    # Sort: prefer most recent year first (so latest hits get YT IDs first)
    todo.sort(key=lambda s: s.get('y') or 0, reverse=True)
    todo = todo[:MAX_LOOKUPS]

    print(f'Looking up YouTube IDs for {len(todo)} songs in parallel (4 workers)...')
    found = 0
    failed = 0
    completed = 0
    save_lock = Lock()

    def worker(s):
        vid = yt_search(s)
        return s, vid

    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(worker, s) for s in todo]
        for fut in as_completed(futures):
            try:
                s, vid = fut.result()
            except Exception as e:
                print(f'  ! worker exception: {e}', file=sys.stderr)
                continue
            if vid:
                s['yt'] = vid
                found += 1
            else:
                s['bad'] = True
                failed += 1
            completed += 1
            if completed % 20 == 0:
                print(f'  {completed}/{len(todo)} | found {found}, failed {failed}')
                # Save partial so a workflow timeout doesn't lose progress
                with save_lock:
                    partial = {'version': 1, 'songs': list(by_id.values())}
                    save_catalog(partial)

    cat = {
        'version': 1,
        'songs': list(by_id.values()),
    }
    save_catalog(cat)

    total = len(by_id)
    with_yt = sum(1 for s in by_id.values() if s.get('yt'))
    print(f'=== Done ===')
    print(f'Total songs:         {total}')
    print(f'With YouTube ID:     {with_yt}')
    print(f'Found this run:      {found}')
    print(f'Failed this run:     {failed}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
