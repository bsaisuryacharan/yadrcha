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
  b album id · l 1 = lyrics in shard · nl 1/2 = probed, no lyrics (2 = current probe)
  yo raw JioSaavn year when repaired · x 1 = lifted off a compilation
  ad date added (YYYY-MM-DD) · md music director · al JioSaavn album id
"""
from __future__ import annotations

import hashlib
import json
import os
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
OVERRIDES_PATH = ROOT / 'data' / 'year_overrides.json'
COMPOSERS_PATH = ROOT / 'data' / 'film_composers.json'
LYRICS_SHARDS = 64

AUDIO_PREFIX = 'https://aac.saavncdn.com/'
COVER_PREFIX = 'https://c.saavncdn.com/'

NOW_YEAR = datetime.now(timezone.utc).year

# Popularity: only well-played songs from films people actually know stay.
# JioSaavn play counts grow with streaming-era reach, so the bars rise with
# the era: a 1960s classic with 30k plays is a hit, a 2010s song with 30k
# is a deep cut nobody asked for. Each era has
#   (song floor, album bar): a song needs `song floor` plays itself, and its
#   film's biggest song needs `album bar` (otherwise the whole film is
#   obscure and goes).
# MIN_PLAYS scales the song floors (default 10000 = the table below; 0
# disables the popularity filter entirely).
MIN_PLAYS = int(os.environ.get('MIN_PLAYS', '10000'))
_ERA_BARS = ((1990, 10_000, 25_000), (2000, 25_000, 100_000), (9999, 50_000, 250_000))
_FRESH_BARS = (10_000, 50_000)         # this year's and last year's releases
DUB_ALBUM_BAR = 1_000_000              # dubbed films: only the big hits


def popularity_bars(year: int | None) -> tuple[int, int]:
    scale = MIN_PLAYS / 10_000
    if year and year >= NOW_YEAR - 1:
        f, a = _FRESH_BARS
    else:
        y = year or 2000
        f, a = next((f, a) for top, f, a in _ERA_BARS if y < top)
    return int(f * scale), int(a * scale)


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
    collapsed = re.sub(r'(.)\1+', r'\1', s)
    # Collapsing doubled letters would turn RRR into "r": keep very short
    # titles as they are.
    return collapsed if len(collapsed) >= 3 else s


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
    # A film single's art: "Rana-Kumbha-From-Varanasi".
    single = re.search(r'-from-(.+)$', slug_name, re.I)
    if single:
        slug_name = single.group(1)
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
    r'live at|vibes?|vol(?:ume)?\.? ?-? ?\d+|(?<!99 )songs|the versions|^i am|all rounder)\b',
    re.IGNORECASE,
)
# Background scores, OSTs, dialogue tracks and instrumental covers: no
# vocals / not songs. Applied to album and song titles.
NON_SONG_RE = re.compile(
    r'background score|\bbgm\b|\bost\b|\bost[’\']?s\b|original sound tracks?\b|theme music|'
    r'original score|bg score|\binstrumental\b|\binterludes?\b|\b(?:dialogues?|dailogues?|'
    r'dialouges?|dialogs?)\b|\bviolin\b|\bveena\b|\bflute\b|\bsaxophone\b|\bpiano\b|'
    r'\bremix(?:es)?\b|\blo-?fi\b|\bmashup\b|\breggaeton\b|\b\w+ mix\)?$|'
    r'dappu beat|\bdj\b.*\b(?:mix|beat|remix)\b|\bfolk\b',
    re.IGNORECASE,
)
# Song titles that are clips, not songs: BGM themes, music bits, teasers,
# speeches. ("Title Song" and "Theme Song" are real songs.)
CLIP_TITLE_RE = re.compile(
    r'\btheme\b(?!\s*song)|\bmusic bit\b|\bbit\s*(?:song|\d)?\s*\)?$|^bit\b|\bteaser\b|\bpromo\b|'
    r'\btrailer\b|\bglimpse\b|\bspeech\b|\bkaraoke\b|\bthe intro\b|^intro\b|\bsignature tune\b|'
    r'\bvoice of\b|\bnarration\b',
    re.IGNORECASE,
)
MIN_SONG_SECONDS = 90      # shorter tracks are bits, jingles and padyam snippets
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
    r'suprabhat\w*|ayyappa|ayyapan|devotional|smarani|smarami|manasa ?smarami|govinda namalu|'
    r'swamy saranam|bhagavan sh?aranam|deity of the day|sai ?baba|shirdi|harathi|harathulu|aarti|'
    r'slokas?|namavali|ashtakam|chalisa|mantras?|jayant?hi|jathara|bonalu|'
    r'bathukamma|christmas|hosanna|yesayya|ministries|ganasudha|sangrah|'
    r'divya ganam|madhura sudha|naamam|hymns?|aditya hrudayam|sahasranamam?|hanuman chalisa)\b',
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

def loose_key(title: str | None) -> str:
    """mkey minus vowels and a leading article/number: catches spelling
    drift (Paandava Vanavasamu / Pandava Vanavasamu)."""
    return re.sub(r'[aeiou]', '', mkey(title))


def _consonants(k: str) -> str:
    return re.sub(r'[aeiouy]', '', k)


class FilmIndex:
    """Wikidata Telugu film titles → release years, tolerant of JioSaavn's
    spelling: exact phonetic key, then the same consonants (Bombai /
    Bombay Priyudu), then a long-enough prefix of the full title
    (Aravindha Sametha → Aravinda Sametha Veera Raghava)."""

    def __init__(self, film_years: dict[str, list[int]]):
        self.exact = film_years
        self.loose: dict[str, set[str]] = defaultdict(set)
        for k in film_years:
            self.loose[_consonants(k)].add(k)
        self.keys = sorted(film_years)

    def lookup(self, movie: str | None, fuzzy: bool = True) -> tuple[list[int] | None, str | None]:
        k = mkey(movie)
        if len(k) < 2:
            return None, None
        if k in self.exact:
            return self.exact[k], 'exact'
        if not fuzzy:
            return None, None
        c = _consonants(k)
        if len(c) >= 4:
            near = [o for o in self.loose.get(c, ()) if SequenceMatcher(None, k, o).ratio() >= 0.8]
            if near:
                return sorted({y for o in near for y in self.exact[o]}), 'loose'
        if len(k) >= 10:
            import bisect
            i = bisect.bisect_left(self.keys, k)
            longer = []
            while i < len(self.keys) and self.keys[i].startswith(k) and len(longer) < 3:
                longer.append(self.keys[i])
                i += 1
            if 1 <= len(longer) <= 2:
                return sorted({y for o in longer for y in self.exact[o]}), 'prefix'
        return None, None


# "Petta (Telugu)", "Dhoom:3 - Telugu", "Jawan (TELUGU)": a multi-language
# release. With no Telugu film of that name on Wikidata it is a dub.
# "They Call Him OG (Kannada)": another language's release of a film.
OTHER_LANG_RE = re.compile(
    r'\(\s*(?:kannada|tamil|hindi|malayalam|marathi|bengali|english)\s*(?:version)?\s*\)|'
    r'[-–]\s*(?:kannada|tamil|hindi|malayalam)\b', re.IGNORECASE)
LANG_SUFFIX_RE = re.compile(
    r'(?:\(\s*telugu\s*(?:version)?\s*\)|[-–]\s*telugu(?:\s+version)?)', re.IGNORECASE)


def name_tokens(names: str | None) -> set[str]:
    """Spelling-proof keys for a list of people ("A, B & C"). Each person
    gives their consonants run together ('S.A. Raj Kumar' and 'S. A.
    Rajkumar' → 'srjkmr'), the same with the words sorted ('S. Thaman' and
    'Thaman S' → '#stmn'), and any distinctive long word ('Balasubrahmanyam' →
    'blsbrmnm'), so formatting differences still match."""
    out = set()
    for person in split_artists(names):
        words = [_consonants(mkey(w)) for w in re.split(r'[^a-z]+', person.lower()) if w]
        words = [w for w in words if w]
        if not words:
            continue
        out.add(''.join(words))
        out.add('#' + ''.join(sorted(words)))
        out.update(w for w in words if len(w) >= 5)
    return out


def load_film_composers() -> dict[tuple[str, int], set[str]]:
    """data/film_composers.json ("Title|year": [composers], from Wikidata)
    → {(film key, year): name tokens}."""
    try:
        raw = json.loads(COMPOSERS_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}
    out: dict[tuple[str, int], set[str]] = defaultdict(set)
    for k, names in raw.items():
        title, _, year = k.rpartition('|')
        if year.isdigit():
            for n in names:
                out[(mkey(title), int(year))] |= name_tokens(n)
    return dict(out)


def save_film_composers(extra: dict[str, list[str]]) -> None:
    try:
        cur = json.loads(COMPOSERS_PATH.read_text(encoding='utf-8'))
    except Exception:
        cur = {}
    for k, names in extra.items():
        cur[k] = sorted(set(cur.get(k, [])) | set(names))
    body = ',\n'.join(f'{json.dumps(k, ensure_ascii=False)}:{json.dumps(v, ensure_ascii=False)}'
                      for k, v in sorted(cur.items()))
    COMPOSERS_PATH.write_text('{\n' + body + '\n}\n', encoding='utf-8')


def override_key(film: str | None) -> str:
    """Like mkey but keeps bracketed qualifiers: Gharshana (Old) and
    Gharshana (New) are different films."""
    return mkey((film or '').replace('(', ' ').replace(')', ' ').replace('[', ' ').replace(']', ' '))


def load_overrides() -> dict[tuple[str, str], int]:
    """data/year_overrides.json → {(film key, title-prefix key): year}."""
    try:
        raw = json.loads(OVERRIDES_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}
    out = {}
    for k, y in raw.items():
        if k.startswith('_'):
            continue
        film, _, title = k.partition('|')
        out[(override_key(film), mkey(title))] = int(y)
    return out


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
             'l', 'nl', 'x', 'nf', 'db', 'ad']


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
            r['nl'] = int(r['nl'])   # 1 = old exact probe, 2 = current probe
        r['u'] = _short(r.get('u'), AUDIO_PREFIX)
        r['c'] = _short(r.get('c'), COVER_PREFIX)
        # `y` may be None (unknown) and `yo` may be 0 (arrived without a year).
        r = {k: r[k] for k in KEY_ORDER if k in r and (k in ('y', 'yo') or r[k] not in (None, '', 0))}
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
    """JioSaavn's original year. `yo: 0` marks a song that arrived with no
    year at all (so a year we guessed for it is never mistaken for raw)."""
    y = s['yo'] if 'yo' in s else s.get('y')
    try:
        return int(y) if y else None
    except (TypeError, ValueError):
        return None


def recording_key(s: dict) -> tuple[str, frozenset]:
    """Same title, same singers = the same recording, whichever album it
    was uploaded on."""
    return mkey(s.get('t')), frozenset(mkey(a) for a in split_artists(s.get('a')))


def _quality(s: dict) -> tuple:
    return (0 if s.get('x') else 1, 1 if s.get('lr') else 0, s.get('p') or 0)


def repair(songs: list[dict], film_years: dict[str, list[int]] | None = None,
           verbose: bool = True) -> list[dict]:
    film_years = film_years if film_years is not None else load_film_years()
    films = FilmIndex(film_years)
    stats = Counter()
    _film_cache: dict[tuple[str, bool], tuple] = {}

    def wiki(movie: str | None) -> tuple[list[int] | None, str | None]:
        """Wikidata years for an album. A "(Telugu)"-suffixed album only
        matches a Telugu film exactly — fuzzy hits there are other films
        (Kaththi (Telugu) is not the 2006 Kathi)."""
        m = movie or ''
        fuzzy = not LANG_SUFFIX_RE.search(m)
        key = (m, fuzzy)
        if key not in _film_cache:
            _film_cache[key] = films.lookup(m, fuzzy=fuzzy)
        return _film_cache[key]

    composers = load_film_composers()

    def composer_fit(group: list[dict], year: int) -> bool | None:
        """Does the Wikidata film of this name and year have the same
        composer as these songs? None when either side is unknown. Keeps
        a 2026 Keeravani song off the 2021 Varanasi."""
        want = set()
        for k in {mkey(group[0].get('m'))} | {o for o in films.loose.get(_consonants(mkey(group[0].get('m'))), ())}:
            want |= composers.get((k, year), set())
        if not want:
            return None
        have = set()
        for s in group:
            have |= name_tokens(s.get('md'))
        if not have:
            # Composers often sing on their own albums.
            for s in group:
                have |= name_tokens(s.get('a'))
            return True if want & have else None
        return bool(want & have)

    def is_dub(movie: str | None, year: int | None, group: list[dict]) -> bool:
        """A dubbed film: JioSaavn's cast lists a non-Telugu lead (`db`, set
        by the refresh), or a "(Telugu)" release that Wikidata doesn't know
        as a Telugu film of about that year. Releases from the last year get
        the benefit of the doubt (Wikidata lags) until the cast check runs."""
        if wiki(movie)[0] is not None:
            # Wikidata knows it as a Telugu film (Kamal Haasan's Telugu
            # films, Mammootty's Swathi Kiranam): not a dub, whoever leads.
            return False
        if any(s.get('db') for s in group):
            return True
        if not LANG_SUFFIX_RE.search(movie or ''):
            return False
        near, _ = films.lookup(movie)
        if near and year and any(abs(year - w) <= 2 for w in near):
            return False
        return not (year and year >= NOW_YEAR - 1)
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
        title = s.get('t') or ''
        known_film = wiki(movie)[0] is not None
        if is_compilation(movie, film_years):
            stats['drop:compilation-album'] += 1
        elif NON_SONG_RE.search(movie) or NON_SONG_RE.search(title):
            stats['drop:score-or-dialogue'] += 1
        elif OTHER_LANG_RE.search(movie):
            stats['drop:other-language'] += 1
        elif CLIP_TITLE_RE.search(title):
            stats['drop:theme-or-clip'] += 1
        elif (s.get('d') or 999) < MIN_SONG_SECONDS:
            stats['drop:too-short'] += 1
        elif (DEVOTIONAL_RE.search(movie) and not _MOTION_PICTURE_RE.search(movie)
              and not known_film):
            stats['drop:devotional'] += 1
        elif not known_film and mkey(movie) == mkey(title):
            # Album named after its only song = a standalone single.
            stats['drop:single'] += 1
        else:
            kept.append(s)
    songs = kept
    # Tribute / artist-showcase albums ("Bahudoorapu Batasari - Ghantasala",
    # "Sid Sriram - The All Rounder"): an album named after its own singer
    # is a re-release anthology, not a film.
    by_album: dict[str, list[dict]] = defaultdict(list)
    for s in songs:
        by_album[s.get('m') or ''].append(s)
    tribute = set()
    for movie, group in by_album.items():
        if wiki(movie)[0] is not None:
            continue
        for part in re.split(r'\s[-–:]\s*', movie)[:3]:
            k = mkey(part)
            if len(k) >= 6 and sum(k in mkey(x.get('a')) for x in group) / len(group) >= 0.6:
                tribute.add(movie)
                break
    if tribute:
        stats['drop:tribute-album'] = sum(len(by_album[m]) for m in tribute)
        songs = [s for s in songs if (s.get('m') or '') not in tribute]

    # 1. Classify each song: trusted year, or needs resolving.
    info = {}
    for s in songs:
        raw = _raw_year(s)
        name, slug_year, legacy = cover_slug(s.get('c') or '')
        match = slug_matches_movie(name, s.get('m', ''))
        # Film-single art ("Song-From-Film") vouches for the film even if an
        # earlier run had flagged the song as a compilation copy.
        single_art = bool(match) and bool(re.search(r'-from-', name or '', re.I))
        if single_art:
            s.pop('x', None)
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
            'raw': raw, 'ceiling': ceiling, 'compilation': compilation, 'song': s,
            'slug_year': None if (compilation or placeholder) else slug_year,
            'suspect': compilation or placeholder or mismatch or raw is None,
            'mk': mkey(s.get('m')), 'tk': mkey(s.get('t')),
        }
        stats['compilation' if compilation else 'placeholder' if placeholder
              else 'mismatch' if mismatch else 'trusted'] += 1

    # 2. Evidence pools built only from trusted songs.
    # 2a. Singer eras first, so we can re-open "trusted" years that no
    # singer on the song could plausibly have recorded (1950s voices on a
    # 2010 "album" are re-releases).
    singer_years: dict[str, list[int]] = defaultdict(list)
    for s in songs:
        inf = info[s['i']]
        if not inf['suspect']:
            for a in split_artists(s.get('a')):
                singer_years[mkey(a)].append(inf['raw'])

    def implausible(s: dict) -> bool:
        inf = info[s['i']]
        if inf['suspect'] or not inf['raw']:
            return False
        meds = []
        for a in split_artists(s.get('a')):
            ys = sorted(singer_years.get(mkey(a), []))
            if len(ys) < 25:
                return False          # not enough history to judge
            meds.append((ys[len(ys) // 10], ys[(9 * len(ys)) // 10]))
        return bool(meds) and all(inf['raw'] > hi + 15 or inf['raw'] < lo - 15 for lo, hi in meds)

    reopened = [s for s in songs if implausible(s)]
    for s in reopened:
        info[s['i']]['suspect'] = True
    stats['reopened:implausible'] = len(reopened)

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
        confident = (q3 - q1) <= 12
        # Singers with a narrow career get a tight window (a 2017 debut
        # can't sing on a 2005 film); wide careers get a generous one.
        p10, p90 = ys[len(ys) // 10], ys[(9 * len(ys)) // 10]
        active = (p10 - 5, p90 + 5) if confident and len(ys) >= 12 else (q1 - 12, q3 + 12)
        return statistics.median(ys), confident, active

    # 2a'. Re-uploads: JioSaavn re-released hundreds of 90s soundtracks in
    # 2013-14 under the upload year (Pelli Sandadi "2014" is 1996). When
    # Wikidata knows the film, no Wikidata year is within a year of ours,
    # and the singers' era is clearly nearer a Wikidata year, the year is
    # re-opened and resolved with that Wikidata year as the lead.
    trusted_groups: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for s in songs:
        inf = info[s['i']]
        if not inf['suspect'] and inf['raw']:
            trusted_groups[(s.get('m') or '', inf['raw'])].append(s)
    for (movie, raw), group in trusted_groups.items():
        wd, _how = wiki(movie)
        if not wd or any(abs(raw - w) <= 1 for w in wd):
            continue
        est, _confident, active = singer_estimate(group)
        if est is None:
            continue
        # Only earlier films: JioSaavn can't have had a song before its film
        # came out, so a later namesake is never the answer.
        fits = [w for w in wd if w <= raw + 1 and (not active or active[0] <= w <= active[1])
                and composer_fit(group, w) is not False]
        if not fits:
            continue
        w = min(fits, key=lambda y: abs(y - est))
        # A film Wikidata knows by exactly this name, released at least three
        # years before JioSaavn's date, is the classic re-upload: accept it
        # unless the singers clearly point elsewhere. Otherwise the singers
        # must clearly prefer the Wikidata year.
        reupload = (_how == 'exact' and len(wd) == 1 and raw - w >= 3
                    and not LANG_SUFFIX_RE.search(movie)
                    and abs(est - w) <= abs(est - raw) + 5)
        if reupload or abs(est - w) + 3 < abs(est - raw):
            for s in group:
                inf = info[s['i']]
                inf.update(suspect=True, wd_hint=w, slug_year=None)
            stats['reopened:wikidata'] += len(group)

    # 2b. Sibling evidence from what is still trusted.
    sib_years: dict[str, Counter] = defaultdict(Counter)
    sib_singers: dict[tuple[str, int], set[str]] = defaultdict(set)
    sib_titles: dict[tuple[str, str], int] = {}
    # The same recording (title + singers) on a film's own album: copies on
    # compilations and re-uploads adopt that album's film and year.
    recordings: dict[tuple[str, frozenset], dict] = {}
    for s in songs:
        inf = info[s['i']]
        if inf['suspect']:
            continue
        sib_years[inf['mk']][inf['raw']] += 1
        k = (inf['mk'], inf['tk'])
        sib_titles[k] = min(sib_titles.get(k, inf['raw']), inf['raw'])
        if not s.get('x'):
            rk = recording_key(s)
            if rk not in recordings or inf['raw'] < info[recordings[rk]['i']]['raw']:
                recordings[rk] = s
        for a in split_artists(s.get('a')):
            sib_singers[(inf['mk'], inf['raw'])].add(mkey(a))

    def resolve(group: list[dict]) -> int | None:
        infs = [info[s['i']] for s in group]
        mk = infs[0]['mk']
        est, confident, active = singer_estimate(group)
        cands: dict[int, float] = defaultdict(float)
        wd, how = wiki(group[0].get('m'))
        for y in wd or ():
            fit = composer_fit(group, y)
            if fit is False:
                # Probably a namesake with another composer — but JioSaavn's
                # composer credits are sometimes wrong, so keep it as a
                # weak fallback rather than nothing.
                cands[y] += 0.5
                continue
            # Spelling-drift matches are a little weaker than exact ones;
            # a matching composer makes either decisive.
            cands[y] += (3 if how == 'exact' else 2) + (2 if fit else 0)
        for inf in infs:
            if inf.get('wd_hint'):
                cands[inf['wd_hint']] += 2 / len(infs)
        singers = {mkey(a) for s in group for a in split_artists(s.get('a'))}
        for y, n in sib_years.get(mk, {}).items():
            # A same-named film only counts fully when it shares singers —
            # otherwise it's probably the remake.
            shared = bool(singers & sib_singers.get((mk, y), set()))
            cands[y] += (2 if shared else 0.6) + min(n, 5) * 0.1
        for inf in infs:
            if inf['slug_year']:
                cands[inf['slug_year']] += 1 / len(infs)
            # A raw year that disagrees only because of a re-upload is
            # still weak evidence when nothing else exists.
            if inf['raw'] and not inf['compilation'] and inf['raw'] != 2000:
                cands[inf['raw']] += 0.5 / len(infs)
        for s in group:
            # Keep an earlier repair so daily runs don't flip-flop — but only
            # while some evidence still backs it (a year that has lost all
            # its evidence was a mistake).
            if 'yo' in s and s.get('y') in cands:
                cands[s['y']] += 2.5 / len(group)
        raws = [inf['raw'] for inf in infs if inf['raw'] and inf['raw'] != 2000]
        if est is None and raws:
            # Nobody on the song has a track record, and the upload is from
            # decades after this candidate film: a namesake, not this film.
            cands = {y: w for y, w in cands.items() if y >= min(raws) - 25}
        ceiling = min([inf['ceiling'] for inf in infs if inf['ceiling']] or [NOW_YEAR])
        cands = {y: w for y, w in cands.items() if 1930 <= y <= min(ceiling, NOW_YEAR)}
        if active:
            # A Chakri song can't be from the 1953 Devadasu, nor a
            # Ghantasala song from the 2006 one.
            # When the singers are confidently placed, nothing outside their
            # careers survives (better the singers' own era than a namesake).
            inside = {y: w for y, w in cands.items() if active[0] <= y <= active[1]}
            cands = inside if (inside or confident) else cands
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
            # A compilation's year is an upper bound; prefer it unless the
            # singers clearly belong to an older era.
            if raws and est >= min(raws) - 10:
                # Same era: the compilation's year is an upper bound and the
                # singers' median a centre; split the difference.
                stats['fix:upload-year'] += len(group)
                return int((est + min(raws)) / 2 + 0.5)
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
        elif recording_key(s) in recordings and recordings[recording_key(s)] is not s:
            src = recordings[recording_key(s)]
            s['y'] = info[src['i']]['raw']
            if mkey(s.get('m')) != mkey(src.get('m')):
                s['m'] = src.get('m')
                inf['mk'] = info[src['i']]['mk']
                s['x'] = 1
            stats['fix:same-recording'] += 1
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
    # 4b. Hand-checked overrides (data/year_overrides.json).
    overrides = load_overrides()
    if overrides:
        for s in songs:
            mk, tk = override_key(s.get('m')), mkey(s.get('t'))
            y = overrides.get((mk, '')) or next(
                (y for (f, t), y in overrides.items() if f == mk and t and tk.startswith(t)), None)
            if y and s['y'] != y:
                s['y'] = y
                stats['fix:override'] += 1
    for s in songs:
        raw = info[s['i']]['raw']
        if raw is None:
            if s['y']:
                s['yo'] = 0
            else:
                s.pop('yo', None)
        elif s['y'] != raw:
            s['yo'] = raw
        else:
            s.pop('yo', None)

    # 5. Compilation copies adopt their film's real cover.
    film_cover: dict[tuple[str, int | None], str] = {}
    for s in sorted(songs, key=lambda s: -(s.get('p') or 0)):
        if not s.get('x'):
            if s.get('c'):
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

    # 6b. Popularity (see popularity_bars). Judged per film first — an
    # obscure film goes whole — then per song. A song with no play data yet
    # inherits its film's median; a film with no play data at all stays
    # only if Wikidata knows it (the next refresh fetches real counts).
    # Dubbed films must be big hits.
    if MIN_PLAYS > 0:
        albums: dict[tuple[str, int | None], list[dict]] = defaultdict(list)
        for s in out:
            albums[(info[s['i']]['mk'], s['y'])].append(s)
        kept_pop = []
        for (_mk, year), group in albums.items():
            floor, bar = popularity_bars(year)
            movie = group[0].get('m')
            dub = is_dub(movie, year, group)
            # No cast on JioSaavn and unknown to Wikidata: a private album
            # (devotional, folk, indie) or an old dub — big hits only.
            castless = wiki(movie)[0] is None and any(s.get('nf') for s in group)
            if dub or castless:
                bar = max(bar, DUB_ALBUM_BAR)
            plays = sorted(s['p'] for s in group if s.get('p'))
            if not plays:
                if wiki(movie)[0] is not None or (year and year >= NOW_YEAR - 1):
                    kept_pop.extend(group)
                else:
                    stats['drop:unverified'] += len(group)
                continue
            if plays[-1] < bar:
                stats['drop:obscure-dub' if dub else 'drop:not-a-film' if castless
                      else 'drop:obscure-film'] += len(group)
                continue
            median = plays[len(plays) // 2]
            for s in group:
                if (s.get('p') or median) >= floor:
                    kept_pop.append(s)
                else:
                    stats['drop:unpopular-song'] += 1
        out = kept_pop

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
