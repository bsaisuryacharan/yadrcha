"""Synced-lyrics lookup on LRCLIB with progressively looser searches.

The first version only asked LRCLIB for an exact artist + title match, which
misses most Telugu songs: JioSaavn lists every singer ("S.P. Balasubrahmanyam,
K. S. Chithra"), spells titles differently, and appends "(From "Film")" or
"- Reprise". So we also search by title, the first singer, and the film, and
accept a result only if it plausibly is the same recording (similar title and,
when both durations are known, a close duration) — a wrong song's lyrics are
worse than none.

`nl` values in the catalogue: 1 = tried with the old exact-match probe (worth
retrying), 2 = tried with this probe (don't retry for a while).
"""
from __future__ import annotations

import re
import urllib.parse
from difflib import SequenceMatcher

PROBE_VERSION = 2
API = 'https://lrclib.net/api'
UA = {'User-Agent': 'yadrcha-catalog/2.0 (github.com/bsaisuryacharan/yadrcha)'}

_PAREN = re.compile(r'\([^)]*\)|\[[^\]]*\]')
_TAIL = re.compile(r'\s*[-–]\s*(?:reprise|remix|lofi|lo-fi|male|female|version|from\b.*|telugu|title song|sad|happy|duet)\b.*$', re.I)


def clean_title(t: str) -> str:
    t = _PAREN.sub(' ', t or '')
    t = _TAIL.sub('', t)
    return re.sub(r'\s+', ' ', t).strip()


def norm(s: str) -> str:
    s = (s or '').lower()
    s = re.sub(r'[^a-z0-9 ]', '', s)
    for a, b in (('th', 't'), ('dh', 'd'), ('ee', 'i'), ('oo', 'u'), ('aa', 'a'), ('w', 'v'), ('z', 'j')):
        s = s.replace(a, b)
    s = re.sub(r'(.)\1+', r'\1', s)
    return re.sub(r'\s+', ' ', s).strip()


def first_singer(a: str) -> str:
    return re.split(r'\s*(?:,|&|\band\b)\s*', a or '')[0].strip()


def similar(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def acceptable(song: dict, cand: dict) -> bool:
    """Is this LRCLIB record plausibly the same recording as `song`?"""
    if not cand.get('syncedLyrics'):
        return False
    ts = max(similar(clean_title(song.get('t')), cand.get('trackName')),
             similar(song.get('t'), cand.get('trackName')))
    if ts < 0.8:
        return False
    dur, cdur = song.get('d') or 0, cand.get('duration') or 0
    if dur and cdur:
        diff = abs(dur - cdur)
        if diff > 12:
            return False
        if diff > 5 and ts < 0.95:
            return False
    else:
        # No duration to compare: require a singer or film to agree too.
        who = norm(cand.get('artistName') or '') + ' ' + norm(cand.get('albumName') or '')
        singers = [norm(x) for x in re.split(r'\s*(?:,|&)\s*', song.get('a') or '') if x.strip()]
        film = norm(clean_title(song.get('m')))
        if not (any(s and s.split()[-1] in who for s in singers) or (film and film in who)):
            return False
    return True


def best(song: dict, cands: list[dict]) -> str | None:
    good = [c for c in cands if isinstance(c, dict) and acceptable(song, c)]
    if not good:
        return None
    dur = song.get('d') or 0
    good.sort(key=lambda c: (-similar(clean_title(song.get('t')), c.get('trackName')),
                             abs((c.get('duration') or dur) - dur)))
    return good[0]['syncedLyrics']


def probe(song: dict, get_json) -> str | None:
    """`get_json(url) -> parsed JSON or None`. Returns LRC text or None."""
    q = urllib.parse.quote
    title, raw_title = clean_title(song.get('t')), song.get('t') or ''
    singer = first_singer(song.get('a'))
    movie = clean_title(song.get('m'))
    dur = song.get('d') or ''

    exact = [
        f'{API}/get?artist_name={q(song.get("a") or "")}&track_name={q(raw_title)}&album_name={q(song.get("m") or "")}&duration={dur}',
        f'{API}/get?artist_name={q(singer)}&track_name={q(title)}&duration={dur}',
    ]
    for url in exact:
        d = get_json(url)
        if isinstance(d, dict) and d.get('syncedLyrics') and acceptable(song, d):
            return d['syncedLyrics']

    searches = [
        f'{API}/search?track_name={q(title)}&artist_name={q(singer)}',
        f'{API}/search?track_name={q(title)}',
        f'{API}/search?q={q(f"{title} {movie}")}',
    ]
    seen: set[str] = set()
    for url in searches:
        d = get_json(url)
        if isinstance(d, list):
            hit = best(song, [c for c in d if str(c.get('id')) not in seen])
            if hit:
                return hit
            seen.update(str(c.get('id')) for c in d if isinstance(c, dict))
    return None
