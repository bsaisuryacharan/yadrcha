#!/usr/bin/env python3
"""
Refresh catalog.json with FULL-LENGTH Telugu film songs from JioSaavn.

Why JioSaavn, not iTunes/YouTube/etc:
- iTunes only serves 30-sec previews (Apple's preview limit)
- YouTube is video, requires IFrame, embed-disabled songs are common
- Spotify needs OAuth + Premium for full tracks
- JioSaavn has the largest legitimate Telugu film catalog
- Full songs available on Saavn's own CDN (aac.saavncdn.com)
- CORS = '*' on the CDN — plays in any browser
- No API key required

Pipeline per song:
1. search.getResults    -> list of {id, song, album, image, year, singers}
2. song.getDetails      -> {encrypted_media_url, duration, ...}
3. DES-ECB decrypt      -> https://aac.saavncdn.com/.../<id>_160.mp4 (full song)

Daily workflow re-runs this with dedupe — catalog grows over time.
"""
from __future__ import annotations

import base64
import html
import json
import os
import re
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
try:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.ciphers import Cipher, modes
    from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
except ImportError:
    sys.exit("Install cryptography: pip install cryptography")


# ---------- Config ----------

# Diverse JioSaavn search queries to seed the catalog. Each returns
# 30-50 results; with dedupe across queries we get 1500-3000 unique songs.
QUERIES = [
    # Composers
    'ilaiyaraaja telugu', 'ar rahman telugu', 'devi sri prasad', 'thaman s telugu',
    'anirudh telugu', 'm m keeravani', 'mickey j meyer', 'harris jayaraj telugu',
    'mani sharma telugu', 'koti telugu', 'chakri telugu', 'rp patnaik',
    'vidyasagar telugu', 'ramana gogula', 'sunny m r',
    # Singers
    'ghantasala telugu', 'spb telugu', 'sid sriram telugu', 'shreya ghoshal telugu',
    'sunitha telugu', 'kk telugu', 'sonu nigam telugu', 'chinmayi telugu',
    'mangli telugu', 'haricharan telugu',
    # Famous movies
    'pushpa telugu', 'baahubali telugu', 'rrr telugu', 'magadheera', 'eega telugu',
    'arjun reddy', 'jersey telugu', 'fidaa telugu', 'ala vaikunthapurramuloo',
    'sarrainodu', 'saaho', 'devara telugu', 'salaar telugu', 'guntur kaaram',
    'kalki 2898', 'hi nanna', 'pokiri telugu', 'okkadu telugu',
    # Era-keyed
    'telugu hits', 'telugu old songs', 'telugu romantic', 'telugu folk',
    'telugu 90s', 'telugu 2000', 'telugu 2010', 'telugu 2024', 'telugu 2025',
    'telugu mass songs', 'telugu melody', 'telugu duet',
]

CATALOG_PATH = Path('catalog.json')
MAX_DETAILS = int(os.environ.get('MAX_DETAILS', '600'))

DES_KEY = b'38346591'

API_BASE = 'https://www.jiosaavn.com/api.php'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/121.0 Safari/537.36',
    'Referer': 'https://www.jiosaavn.com/',
    'Accept': 'application/json,text/javascript,*/*;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
}

# A shared session reuses the connection pool.
SESSION = requests.Session()
SESSION.headers.update(HEADERS)


# ---------- JioSaavn API ----------

def jio_get(call: str, params: dict, max_attempts: int = 5) -> dict | None:
    """Call JioSaavn API with retry+backoff on 429/5xx."""
    qs = {
        '__call': call,
        '_format': 'json',
        '_marker': '0',
        'ctx': 'web6dot0',
        **params,
    }
    url = f'{API_BASE}?{urllib.parse.urlencode(qs)}'
    delay = 10
    for attempt in range(1, max_attempts + 1):
        try:
            r = SESSION.get(url, timeout=20)
            if r.status_code in (429, 502, 503):
                print(f'  ! {call} {r.status_code} (attempt {attempt}/{max_attempts}) — wait {delay}s', file=sys.stderr)
                time.sleep(delay)
                delay = min(delay * 2, 240)
                continue
            r.raise_for_status()
            # JioSaavn sometimes returns JSON-with-junk-prefix; tolerate
            text = r.text
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                # Strip leading junk before first '{'
                start = text.find('{')
                if start >= 0:
                    return json.loads(text[start:])
                return None
        except Exception as e:
            print(f'  ! {call} error (attempt {attempt}): {e}', file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 240)
    return None


def search_songs(query: str) -> list[dict]:
    res = jio_get('search.getResults', {'q': query, 'p': '1', 'n': '40'})
    if not res:
        return []
    return res.get('results', []) or []


def song_details(song_id: str) -> dict | None:
    """Returns the song's encrypted_media_url and full metadata."""
    res = jio_get('song.getDetails', {'pids': song_id})
    if not res:
        return None
    songs = res.get('songs') or []
    return songs[0] if songs else None


# ---------- URL decryption ----------

def decrypt_media_url(encrypted_b64: str) -> str | None:
    """Decrypts JioSaavn's encrypted_media_url to a real CDN URL.

    Algorithm: DES-ECB with key '38346591', PKCS7 padding (we don't enforce
    strict padding — just strip trailing pad bytes if reasonable).
    """
    try:
        # cryptography uses TripleDES — when the key is 8 bytes it operates
        # as plain DES (compatible with single-DES ECB).
        key3 = DES_KEY * 3  # 24 bytes for TripleDES API
        cipher = Cipher(TripleDES(key3), modes.ECB(), backend=default_backend())
        d = cipher.decryptor()
        raw = d.update(base64.b64decode(encrypted_b64)) + d.finalize()
        if not raw:
            return None
        # Strip PKCS7 padding (last byte is pad length)
        pad = raw[-1]
        if 0 < pad <= 8:
            raw = raw[:-pad]
        url = raw.decode('utf-8', errors='ignore').strip('\x00').strip()
        if not url.startswith('http'):
            return None
        return url
    except Exception as e:
        print(f'  ! decrypt failed: {e}', file=sys.stderr)
        return None


def upgrade_quality(url: str) -> str:
    """Replace _96.mp4 / _128.mp4 with _160.mp4 for higher quality.
    Falls back to whatever exists; frontend can always play whichever URL."""
    return re.sub(r'_(?:96|128)\.mp4$', '_160.mp4', url)


def hd_image(url: str) -> str:
    """JioSaavn covers come at 150x150; upscale URL to 500x500."""
    return re.sub(r'(\d{2,4})x\1', '500x500', url) if url else url


def clean_text(s: str) -> str:
    if not s:
        return ''
    return html.unescape(s).strip()


# ---------- Normalize ----------

# Major Telugu film music labels — used as a positive signal for film songs
TELUGU_FILM_LABELS = {
    'aditya music', 't-series', 'lahari music', 'mango music',
    'saregama', 'sony music', 'sony music entertainment', 'sony music india',
    'times music', 'super cassettes industries', 'tips', 'venus records',
    'eros music', 'panorama music', 'sa re ga ma', 'aditya music india',
    'shemaroo', 'speed records', 'zee music', 'junglee music',
    'starmusiq', 'think music', 'divo', 'muzik247', 'amruthavarshini',
}

# Words that strongly signal NON-film content
NON_FILM_TERMS = {
    'bhajan', 'mantra', 'sloka', 'stotram', 'vandanam', 'aarti', 'kirtan',
    'bhakti', 'devotional', 'chant', 'meditation', 'lullaby', 'spiritual',
    'remix dj', 'cover song', 'unplugged', 'reprise',
}


def is_film_song(d: dict) -> bool:
    """Return True if the song appears to be from a Telugu film soundtrack.

    Heuristic combines several signals:
      - label is a known Telugu film music label, OR
      - has a 'starring' field (movie cast list), OR
      - album_url contains '-telugu' suffix (movie album convention)
      - AND no devotional/non-film keywords in song or album name
    """
    title_lc = (d.get('song') or '').lower()
    album_lc = (d.get('album') or '').lower()
    label_lc = (d.get('label') or '').lower()
    album_url = d.get('album_url') or ''
    starring = (d.get('starring') or '').strip()

    # Negative filter — exclude obvious non-film content
    haystack = title_lc + ' ' + album_lc
    if any(term in haystack for term in NON_FILM_TERMS):
        return False
    # Singles / EPs without movie context
    if album_lc.endswith(' - single') or album_lc.endswith(' - ep'):
        return False

    # Positive signals — need at least one
    label_match = any(lbl in label_lc for lbl in TELUGU_FILM_LABELS)
    has_starring = bool(starring)
    movie_album = '-telugu' in album_url.lower() or 'soundtrack' in album_lc
    return label_match or has_starring or movie_album


def normalize_detail(d: dict) -> dict | None:
    if not d:
        return None
    if (d.get('language') or '').lower() != 'telugu':
        return None
    if not is_film_song(d):
        return None
    enc = d.get('encrypted_media_url')
    if not enc:
        return None
    media_url = decrypt_media_url(enc)
    if not media_url:
        return None
    media_url = upgrade_quality(media_url)
    title = clean_text(d.get('song') or '')
    album = clean_text(d.get('album') or '')
    singers = clean_text(d.get('singers') or d.get('primary_artists') or '')
    music = clean_text(d.get('music') or '')
    artist = singers or music or 'Unknown'
    image = hd_image(d.get('image') or '')
    try:
        year = int(d.get('year')) if d.get('year') else None
    except ValueError:
        year = None
    try:
        duration = int(d.get('duration')) if d.get('duration') else None
    except (TypeError, ValueError):
        duration = None
    return {
        'i': d.get('id'),
        't': title,
        'a': artist,
        'm': album,
        'u': media_url,
        'c': image,
        'y': year,
        'd': duration or 240,
    }


# ---------- Catalog I/O ----------

def load_catalog() -> dict:
    if CATALOG_PATH.exists():
        try:
            with CATALOG_PATH.open('r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f'! Could not load existing catalog: {e}', file=sys.stderr)
    return {'version': 2, 'songs': []}


def save_catalog(cat: dict) -> None:
    cat['updated'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    with CATALOG_PATH.open('w', encoding='utf-8') as f:
        json.dump(cat, f, separators=(',', ':'), ensure_ascii=False)


# ---------- Main ----------

def main() -> int:
    print('=== Yadrcha catalog refresh (JioSaavn) ===')
    cat = load_catalog()
    by_id: dict[str, dict] = {s['i']: s for s in cat.get('songs', [])}
    existing_count = len(by_id)
    print(f'Loaded {existing_count} existing songs')

    # 1. Search across queries — collect candidate song IDs to detail-fetch
    candidates: dict[str, dict] = {}  # song_id -> light search result
    for i, q in enumerate(QUERIES, 1):
        results = search_songs(q)
        added = 0
        for r in results:
            sid = r.get('id')
            if not sid:
                continue
            if sid not in by_id and sid not in candidates:
                candidates[sid] = r
                added += 1
        print(f'[search {i}/{len(QUERIES)}] {q!r}: {len(results)} hits, {added} new candidates')
        time.sleep(1.0)  # be polite

    print(f'Total new candidates: {len(candidates)}')

    # 2. Fetch full details (with encrypted_media_url) in parallel.
    # Cap at MAX_DETAILS so a single workflow run stays under the time budget.
    todo = list(candidates.values())[:MAX_DETAILS]
    print(f'Fetching details for {len(todo)} songs (4 parallel workers)...')

    save_lock = Lock()
    found = 0
    failed = 0
    completed = 0

    def worker(meta):
        sid = meta['id']
        d = song_details(sid)
        if not d:
            return None
        return normalize_detail(d)

    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(worker, m) for m in todo]
        for fut in as_completed(futures):
            try:
                song = fut.result()
            except Exception as e:
                print(f'  ! worker exception: {e}', file=sys.stderr)
                song = None
            if song and song.get('u'):
                by_id[song['i']] = song
                found += 1
            else:
                failed += 1
            completed += 1
            if completed % 25 == 0:
                print(f'  {completed}/{len(todo)} | added {found}, failed {failed}')
                with save_lock:
                    partial = {'version': 2, 'songs': list(by_id.values())}
                    save_catalog(partial)

    cat = {'version': 2, 'songs': list(by_id.values())}
    save_catalog(cat)

    total = len(by_id)
    print('=== Done ===')
    print(f'Songs in catalog: {total} (was {existing_count})')
    print(f'Added this run:   {found}')
    print(f'Failed this run:  {failed}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
