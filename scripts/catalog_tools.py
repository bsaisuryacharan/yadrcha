#!/usr/bin/env python3
"""
Catalog post-processing shared by the daily refresh (refresh_catalog.py) and
runnable on its own to rebuild/repair the committed catalog in place:

    python scripts/catalog_tools.py

What it does
------------
1. YEAR REPAIR. JioSaavn's `year` is unreliable for older films:
   * ~800 legacy uploads carry a placeholder year of 2000 (cover file
     `Swati-Mutyam-2000-500x500.jpg` for a 1986 film).
   * Songs lifted off label compilations ("Alanati Suswaralu 2018",
     "Romantic 90's") carry the compilation's year, not the film's.
   * Some re-uploads carry the upload year (Karna 2013 → really 1995).
   Every song is re-derived from its *raw* JioSaavn year (kept in `yo` when
   we change it, so repairs are idempotent) using, in order of trust:
   a sibling song of the same film with a trusted year, Wikidata film
   release years (data/film_years.json), the year embedded in the cover
   file name, and finally a singer-era estimate.
2. DE-DUPLICATION of compilation copies of a song that also exists on the
   film's own album.
3. ALBUM IDS (`b`) so the app can group a film's soundtrack reliably.
4. OUTPUT SPLIT for mobile: catalog.json holds metadata only (CDN prefixes
   stripped, ~2.5MB raw / ~0.7MB gzipped) and synced lyrics live in 64 shards
   under lyrics/, fetched only when a song's lyrics are opened.

Catalog row keys (v3):
  i id · t title · a singers · m movie · u audio path · c cover path
  y release year (None = unknown) · d duration s · p play count
  b album id · l 1 = lyrics in shard · nl 1 = probed, no lyrics
  yo raw JioSaavn year when repaired · x 1 = lifted off a compilation
  ad date added (YYYY-MM-DD) · md music director · al JioSaavn album id
"""
from __future__ import annotations

import hashlib
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = ROOT / 'catalog.json'
LYRICS_DIR = ROOT / 'lyrics'
FILM_YEARS_PATH = ROOT / 'data' / 'film_years.json'
LYRICS_SHARDS = 64

AUDIO_PREFIX = 'https://aac.saavncdn.com/'
COVER_PREFIX = 'https://c.saavncdn.com/'

NOW_YEAR = datetime.now(timezone.utc).year


# ---------- keys ----------

_PAREN_RE = re.compile(r'\([^)]*\)|\[[^\]]*\]')
_DIGRAPHS = (('th', 't'), ('dh', 'd'), ('bh', 'b'), ('kh', 'k'), ('gh', 'g'),
             ('ph', 'f'), ('sh', 's'), ('ch', 'c'), ('jh', 'j'), ('ee', 'i'),
             ('oo', 'u'), ('w', 'v'), ('z', 'j'), ('q', 'k'), ('x', 'ks'))


def mkey(s: str | None) -> str:
    """Loose phonetic key so transliteration variants collide:
    'Swathi Muthyam' == 'Swati Mutyam', 'S.P. Balasubrahmanyam' ==
    'S P Balasubramanyam'."""
    s = _PAREN_RE.sub(' ', (s or '').lower())
    s = re.sub(r'\s*-\s*(?:telugu|tamil|hindi|kannada|malayalam)\s*$', '', s)
    s = re.sub(r'[^a-z0-9]', '', s)
    for a, b in _DIGRAPHS:
        s = s.replace(a, b)
    s = s.replace('h', '')
    s = re.sub(r'(.)\1+', r'\1', s)
    return s


def split_artists(a: str | None) -> list[str]:
    return [x.strip() for x in re.split(r'\s*(?:,|&|\band\b)\s*', a or '') if x.strip()]


_SLUG_RE = re.compile(
    r'^(?P<name>.*?)(?:-(?:telugu|tamil|hindi|kannada|malayalam|english))?'
    r'-(?P<year>(?:19|20)\d\d)(?P<ts>-\d{8,})?$', re.IGNORECASE)


def cover_slug(cover: str) -> tuple[str | None, int | None, bool]:
    """('Swati-Mutyam', 2000, legacy) from '.../Swati-Mutyam-2000-500x500.jpg'.
    `legacy` = old upload without a timestamp (its year is a placeholder
    when it reads 2000)."""
    f = (cover or '').rsplit('/', 1)[-1]
    f = re.sub(r'-\d+x\d+\.\w+$', '', f)
    m = _SLUG_RE.match(f)
    if not m:
        return None, None, False
    return m.group('name'), int(m.group('year')), not m.group('ts')


def slug_matches_movie(slug_name: str | None, movie: str) -> bool | None:
    """None when the slug carries no usable name (ART-00213, SONY_...)."""
    if not slug_name or re.match(r'^(art|sony|sncd|inh|inr)\b', slug_name, re.I):
        return None
    a, b = mkey(slug_name.replace('-', ' ')), mkey(movie)
    if len(a) < 3:
        return None
    if not b:
        return False
    if a in b or b in a:
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.62


# Label compilations ("Non Stop Love Songs", "Tollywood Rewind 2000") carry
# the compilation's year and art, not the film's, so they'd put old songs
# in the wrong era. Songs on them are dropped; the same songs arrive via
# their real film albums.
COMPILATION_RE = re.compile(
    r'\b(collection|best of|hits of|songs of|compilation|jukebox|patriotic|'
    r'all time|chartbusters|top hits|top songs|favorites|romantic hits|dance hits|'
    r'super ?hits?|melody hits|throwback|evergreen|special hit|popular hit|'
    r'golden hit|playlist|essentials|originals|anthems|vibes|year wise|'
    r'decade|fresh hits|new hits|hit songs|hit collection|songs collection|'
    r'love songs|sad songs|party hits|pop hits|hottest hits|trending hits|'
    r'valentines?|valentiens|kavithalu|non ?stop|day special|special songs|spl|'
    r'rewind|jhankar|bhakthi|bhakti|celebrations?|celebrating|new year|mashup|medley|'
    r'hits|duets|duet songs|unforgettables?|then (?:&|and) now|trending|golden hour|'
    r'item songs|folk songs|tribute|tunes of|block ?busters?|beauties|retro style|special|'
    r'journey|voice of|icons of|travel with music|heart touching|dhinostavam|salute india|'
    r'sthuthi|non ?-? ?film|carnatic|nursery|rhymes|fables|kids|lullab(?:y|ies)|'
    r'party|workout|lofi|remix(?:es)?|reprise|unplugged|cover songs?|karaoke|'
    r'duet|pro max|gorgeous|music of love|winds & melody|romantic kings|cine gola|'
    r'december season|brahmotsav\w*|concert|'
    # classical / dance recitals
    r'krithis?|kritis?|keerthanalu|sankeerthan\w*|t?h?yagaraja|annamach\w*|raagam|'
    r'bharath?a?anatyam|swararchana|nrithyopasana|noopuranadham|gems of|'
    # DJ remixes, lo-fi, folk, stage
    r'mix|chill ?trap|reggaeton|lo ?-?fi|lofis|synthwave|folk songs?|oggu katha|stage play|'
    # devotional / Christian collections, star anthologies, misc.
    r'ganapathy|ekadantaya|bhagawadh? geetha|jai shri ram|yesanna|yesey|prabhu|translation|'
    r'nightingale|magic of|dance with|dance dynamite|fantastic 9|youth stars|golden years|'
    r'swarasudha|icon star|love failure|propose day|classic marvel|way to peace|glimpse|'
    r'live at|vibes?|vol(?:ume)?\.? ?-? ?\d+|(?<!99 )songs)\b',
    re.IGNORECASE,
)
# Background scores, OSTs, dialogue tracks and instrumental covers: no
# vocals / not songs. Applied to album and song titles.
NON_SONG_RE = re.compile(
    r'background score|\bbgm\b|\bost\b|\bost[’\']?s\b|original sound tracks?\b|theme music|'
    r'original score|bg score|\binstrumental\b|\binterludes?\b|\b(?:dialogues?|dailogues?|'
    r'dialouges?|dialogs?)\b|\bviolin\b|\bveena\b|\bflute\b|\bsaxophone\b|\bpiano\b|'
    r'\bremix(?:es)?\b|\blo-?fi\b|\bmashup\b|\breggaeton\b|\b\w+ mix\)?$',
    re.IGNORECASE,
)
_YEAR_TAGGED_RE = re.compile(r'\b(?:19|20)\d{2}\b')
_GENERIC_TERMS_RE = re.compile(
    r'\b(hits?|songs?|telugu|tollywood|pop|romantic|dance|sad|love|fresh|'
    r'new|special|jukebox|mix|chart|collection|best|top|popular|year)\b',
    re.IGNORECASE,
)


# Devotional / festival albums — not film music. Real films with such
# titles (Shirdi Sai, Sri Ramadasu, Mass Jathara) are kept when Wikidata
# knows them as films or JioSaavn labels them a motion-picture soundtrack.
DEVOTIONAL_RE = re.compile(
    r'\b(patal[au]|geeth?alu|geetamrutham|bhajans?|keerthan(?:a|alu)|stotram|'
    r'suprabhatha?m|ayyappa|devotional|sai ?baba|shirdi|harathi|harathulu|aarti|'
    r'slokas?|namavali|ashtakam|chalisa|mantras?|jayant?hi|jathara|bonalu|'
    r'bathukamma|christmas|hosanna|yesayya|ministries|ganasudha|sangrah|'
    r'divya ganam|madhura sudha|naamam)\b',
    re.IGNORECASE,
)
_MOTION_PICTURE_RE = re.compile(r'motion picture|soundtrack', re.IGNORECASE)

# "Song (From "Real Movie")" — JioSaavn's pattern for film songs packaged
# on compilations.
FROM_MOVIE_RE = re.compile(r'\(\s*from\s+["“]([^"”]+)["”]\s*\)', re.IGNORECASE)

# Real films whose titles trip the compilation keywords.
_FILM_EXCEPTIONS = re.compile(r'^(operation valentine|the greatest of all time)\b', re.IGNORECASE)


def is_compilation(album: str | None, film_years: dict | None = None) -> bool:
    if not album or _FILM_EXCEPTIONS.search(album):
        return False
    if film_years and mkey(album) in film_years:
        return False
    if COMPILATION_RE.search(album):
        return True
    return bool(_YEAR_TAGGED_RE.search(album) and _GENERIC_TERMS_RE.search(album))


def album_id(movie: str, year: int | None) -> str:
    h = hashlib.sha1(f'{mkey(movie)}|{year or "?"}'.encode()).hexdigest()
    return h[:8]


def lyrics_shard(song_id: str) -> int:
    """FNV-1a 32-bit — mirrored by lyricsShard() in src/lyrics.js."""
    h = 0x811C9DC5
    for ch in song_id.encode('utf-8'):
        h = ((h ^ ch) * 0x01000193) & 0xFFFFFFFF
    return h % LYRICS_SHARDS


# ---------- I/O ----------

def load_film_years() -> dict[str, list[int]]:
    try:
        raw = json.loads(FILM_YEARS_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}
    out: dict[str, set[int]] = defaultdict(set)
    for title, years in raw.items():
        k = mkey(title)
        if len(k) >= 2:
            out[k].update(int(y) for y in years)
    return {k: sorted(v) for k, v in out.items()}


def save_film_years(extra: dict[str, list[int]]) -> None:
    """Merge freshly fetched Wikidata titles into data/film_years.json."""
    try:
        cur = json.loads(FILM_YEARS_PATH.read_text(encoding='utf-8'))
    except Exception:
        cur = {}
    for t, ys in extra.items():
        cur[t] = sorted(set(cur.get(t, [])) | set(ys))
    FILM_YEARS_PATH.parent.mkdir(parents=True, exist_ok=True)
    body = ',\n'.join(f'{json.dumps(k, ensure_ascii=False)}:{json.dumps(v)}'
                      for k, v in sorted(cur.items()))
    FILM_YEARS_PATH.write_text('{\n' + body + '\n}\n', encoding='utf-8')


def _full(url: str | None, prefix: str) -> str:
    if not url:
        return ''
    return url if url.startswith('http') else prefix + url


def _short(url: str | None, prefix: str) -> str:
    if not url:
        return ''
    return url[len(prefix):] if url.startswith(prefix) else url


def load_catalog() -> list[dict]:
    """Songs with absolute URLs and inline `lr` lyrics (merged back from
    the shards) — the in-memory shape the refresh pipeline works on."""
    if not CATALOG_PATH.exists():
        return []
    try:
        cat = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
    except Exception as e:
        print(f'! Could not load catalog: {e}', file=sys.stderr)
        return []
    songs = cat.get('songs', [])
    lyrics: dict[str, str] = {}
    if LYRICS_DIR.exists():
        for p in LYRICS_DIR.glob('*.json'):
            try:
                lyrics.update(json.loads(p.read_text(encoding='utf-8')))
            except Exception:
                pass
    for s in songs:
        s['u'] = _full(s.get('u'), AUDIO_PREFIX)
        s['c'] = _full(s.get('c'), COVER_PREFIX)
        if s.get('i') in lyrics:
            s['lr'] = lyrics[s['i']]
        s.pop('l', None)
    return songs


KEY_ORDER = ['i', 't', 'a', 'm', 'md', 'y', 'yo', 'd', 'p', 'b', 'al', 'u', 'c',
             'l', 'nl', 'x', 'ad']


def save_catalog(songs: list[dict]) -> None:
    shards: dict[int, dict[str, str]] = defaultdict(dict)
    rows = []
    for s in songs:
        r = dict(s)
        lr = r.pop('lr', None)
        if lr:
            shards[lyrics_shard(r['i'])][r['i']] = lr
            r['l'] = 1
            r.pop('nl', None)
        elif r.get('nl'):
            r['nl'] = 1
        r['u'] = _short(r.get('u'), AUDIO_PREFIX)
        r['c'] = _short(r.get('c'), COVER_PREFIX)
        r = {k: r[k] for k in KEY_ORDER if k in r and r[k] not in (None, '', 0) or k == 'y' and k in r}
        rows.append(r)
    # Stable order keeps daily diffs small.
    rows.sort(key=lambda r: (r.get('b', ''), r['i']))
    cat = {
        'version': 3,
        'updated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'prefix': {'u': AUDIO_PREFIX, 'c': COVER_PREFIX},
        'shards': LYRICS_SHARDS,
        'songs': rows,
    }
    CATALOG_PATH.write_text(json.dumps(cat, ensure_ascii=False, separators=(',', ':')),
                            encoding='utf-8')
    LYRICS_DIR.mkdir(exist_ok=True)
    for n in range(LYRICS_SHARDS):
        data = dict(sorted(shards.get(n, {}).items()))
        (LYRICS_DIR / f'{n:02d}.json').write_text(
            json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


# ---------- repair ----------

def _raw_year(s: dict) -> int | None:
    y = s.get('yo', s.get('y'))
    try:
        return int(y) if y else None
    except (TypeError, ValueError):
        return None


def _quality(s: dict) -> tuple:
    return (0 if s.get('x') else 1, 1 if s.get('lr') else 0, s.get('p') or 0)


def repair(songs: list[dict], film_years: dict[str, list[int]] | None = None,
           verbose: bool = True) -> list[dict]:
    film_years = film_years if film_years is not None else load_film_years()
    stats = Counter()
    # 0. Rescue compilation copies whose title names the real film, then
    # drop what's still a compilation or a devotional album.
    for s in songs:
        for field in ('m', 't'):
            m = FROM_MOVIE_RE.search(s.get(field) or '')
            if not m:
                continue
            film = m.group(1).strip()
            if field == 't':
                s['t'] = FROM_MOVIE_RE.sub('', s['t']).strip() or s['t']
            if mkey(film) != mkey(s.get('m')):
                s['m'] = film
                s['x'] = 1
                stats['rescued-from-title'] += 1
    kept = []
    for s in songs:
        movie = s.get('m') or ''
        if is_compilation(movie, film_years):
            stats['drop:compilation-album'] += 1
        elif NON_SONG_RE.search(movie) or NON_SONG_RE.search(s.get('t') or ''):
            stats['drop:score-or-dialogue'] += 1
        elif (DEVOTIONAL_RE.search(movie) and not _MOTION_PICTURE_RE.search(movie)
              and mkey(movie) not in film_years):
            stats['drop:devotional'] += 1
        else:
            kept.append(s)
    songs = kept

    # 1. Classify each song: trusted year, or needs resolving.
    info = {}
    for s in songs:
        raw = _raw_year(s)
        name, slug_year, legacy = cover_slug(s.get('c', ''))
        match = slug_matches_movie(name, s.get('m', ''))
        compilation = bool(s.get('x')) or match is False
        placeholder = legacy and slug_year == 2000 and raw == 2000
        mismatch = (not compilation and slug_year is not None and raw is not None
                    and slug_year != 2000 and abs(slug_year - raw) > 1)
        if compilation:
            s['x'] = 1
        # Latest year the film could be from: a song can't predate its own
        # upload. Legacy placeholder uploads all happened before ~2015.
        ceiling = 2015 if placeholder else (raw + 1 if raw else None)
        info[s['i']] = {
            'raw': raw, 'ceiling': ceiling, 'compilation': compilation,
            'slug_year': None if (compilation or placeholder) else slug_year,
            'suspect': compilation or placeholder or mismatch or raw is None,
            'mk': mkey(s.get('m')), 'tk': mkey(s.get('t')),
        }
        stats['compilation' if compilation else 'placeholder' if placeholder
              else 'mismatch' if mismatch else 'trusted'] += 1

    # 2. Evidence pools built only from trusted songs.
    sib_years: dict[str, Counter] = defaultdict(Counter)
    sib_singers: dict[tuple[str, int], set[str]] = defaultdict(set)
    sib_titles: dict[tuple[str, str], int] = {}
    singer_years: dict[str, list[int]] = defaultdict(list)
    for s in songs:
        inf = info[s['i']]
        if inf['suspect']:
            continue
        sib_years[inf['mk']][inf['raw']] += 1
        sib_titles.setdefault((inf['mk'], inf['tk']), inf['raw'])
        for a in split_artists(s.get('a')):
            singer_years[mkey(a)].append(inf['raw'])
            sib_singers[(inf['mk'], inf['raw'])].add(mkey(a))

    def singer_estimate(group: list[dict]) -> tuple[float | None, bool, tuple[int, int] | None]:
        """(median year, confident?, plausible active range) of the singers
        across one album upload."""
        ys: list[int] = []
        for s in group:
            for a in split_artists(s.get('a')):
                ys.extend(singer_years.get(mkey(a), []))
        if len(ys) < 6:
            return None, False, None
        ys.sort()
        q1, q3 = ys[len(ys) // 4], ys[(3 * len(ys)) // 4]
        return statistics.median(ys), (q3 - q1) <= 12, (q1 - 12, q3 + 12)

    def resolve(group: list[dict]) -> int | None:
        infs = [info[s['i']] for s in group]
        mk = infs[0]['mk']
        est, confident, active = singer_estimate(group)
        cands: dict[int, float] = defaultdict(float)
        for y in film_years.get(mk, []):
            cands[y] += 3
        singers = {mkey(a) for s in group for a in split_artists(s.get('a'))}
        for y, n in sib_years.get(mk, {}).items():
            # A same-named film only counts fully when it shares singers —
            # otherwise it's probably the remake.
            shared = bool(singers & sib_singers.get((mk, y), set()))
            cands[y] += (2 if shared else 0.6) + min(n, 5) * 0.1
        for s in group:
            # Keep an earlier repair unless stronger evidence has appeared,
            # so daily runs don't flip-flop.
            if 'yo' in s and s.get('y'):
                cands[s['y']] += 1.5 / len(group)
        for inf in infs:
            if inf['slug_year']:
                cands[inf['slug_year']] += 1 / len(infs)
            # A raw year that disagrees only because of a re-upload is
            # still weak evidence when nothing else exists.
            if inf['raw'] and not inf['compilation'] and inf['raw'] != 2000:
                cands[inf['raw']] += 0.5 / len(infs)
        ceiling = min([inf['ceiling'] for inf in infs if inf['ceiling']] or [NOW_YEAR])
        cands = {y: w for y, w in cands.items() if 1930 <= y <= min(ceiling, NOW_YEAR)}
        if active:
            # A Chakri song can't be from the 1953 Devadasu, nor a
            # Ghantasala song from the 2006 one.
            cands = {y: w for y, w in cands.items() if active[0] <= y <= active[1]} or cands
        if est is not None:
            # Same-name remakes decades apart: the singers decide.
            pull = 2.5 if confident else 1.0
            for y in cands:
                cands[y] += pull * max(0.0, 1 - abs(y - est) / 15)
        if cands:
            ref = est if est is not None else 2000
            stats['fix:evidence'] += len(group)
            return max(cands, key=lambda y: (cands[y], -abs(y - ref)))
        if est is not None and confident:
            stats['fix:singer-era'] += len(group)
            return int(round(est))
        stats['fix:unknown'] += len(group)
        return None

    # 3. Resolve suspect years — per album upload (film + cover), so every
    # song of one upload moves together and pools its singers as evidence.
    uploads: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for s in songs:
        inf = info[s['i']]
        if not inf['suspect']:
            s['y'] = inf['raw']
        elif (inf['mk'], inf['tk']) in sib_titles:
            s['y'] = sib_titles[(inf['mk'], inf['tk'])]
            stats['fix:sibling-title'] += 1
        else:
            uploads[(inf['mk'], s.get('c', ''))].append(s)
    for group in uploads.values():
        year = resolve(group)
        for s in group:
            s['y'] = year

    # 4. Snap near-identical years of one film together (1998 vs 1999 split
    # one soundtrack into two albums).
    by_film: dict[str, list[dict]] = defaultdict(list)
    for s in songs:
        by_film[info[s['i']]['mk']].append(s)
    for group in by_film.values():
        years = Counter(s['y'] for s in group if s['y'])
        for s in group:
            if not s['y']:
                if len(years) == 1:
                    s['y'] = next(iter(years))
                continue
            s['y'] = max((y for y in years if abs(y - s['y']) <= 1),
                         key=lambda y: (years[y], -y))
    for s in songs:
        raw = info[s['i']]['raw']
        if raw is not None and s['y'] != raw:
            s['yo'] = raw
        else:
            s.pop('yo', None)

    # 5. Compilation copies adopt their film's real cover.
    film_cover: dict[tuple[str, int | None], str] = {}
    for s in sorted(songs, key=lambda s: -(s.get('p') or 0)):
        if not s.get('x'):
            film_cover.setdefault((info[s['i']]['mk'], s['y']), s['c'])
    for s in songs:
        if s.get('x'):
            c = film_cover.get((info[s['i']]['mk'], s['y']))
            if c:
                s['c'] = c

    # 6. De-duplicate (same film, same title, same year) keeping the best copy.
    best: dict[tuple, dict] = {}
    for s in songs:
        k = (info[s['i']]['mk'], info[s['i']]['tk'], s['y'])
        cur = best.get(k)
        if cur is None:
            best[k] = s
            continue
        keep, drop = (s, cur) if _quality(s) > _quality(cur) else (cur, s)
        if not keep.get('lr') and drop.get('lr'):
            keep['lr'] = drop['lr']
            keep.pop('nl', None)
        best[k] = keep
        stats['dedupe'] += 1
    out = list(best.values())

    # 7. Album ids.
    for s in out:
        s['b'] = album_id(s.get('m', ''), s['y'])

    if verbose:
        print('Year repair:', dict(stats))
    return out


def main() -> int:
    songs = load_catalog()
    print(f'Loaded {len(songs)} songs')
    songs = repair(songs)
    save_catalog(songs)
    years = Counter((s['y'] // 10 * 10) if s['y'] else None for s in songs)
    print(f'Saved {len(songs)} songs · decades:', dict(sorted(years.items(), key=lambda kv: kv[0] or 0)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
