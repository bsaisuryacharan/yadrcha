# Yadrcha · Random Telugu Music

A one-tap shuffle player for random Telugu film music — old to latest. Press the green button, hear something. No login, no setup.

**Live: https://bsaisuryacharan.github.io/yadrcha/**

## Features

- **One-tap shuffle** — single big button, lean-back radio model
- **Phone-frame UI** on desktop, full-screen on mobile
- **Living Orb visualizer** (Three.js) — a noise-displaced energy orb in a
  void that morphs and pulses to the live audio spectrum (Web Audio): bass
  drives the pulse, highs shimmer the surface, and a fresnel halo sharpens
  with loudness. The orb + ambient glow auto-tint to each cover's dominant
  colour. Reacts to mouse / device tilt. Degrades gracefully if WebGL/Three.js
  is unavailable.
- **Now-playing poster** — the movie album art is shown crisply in the
  bottom-left strip, with a glowing frame that pops on each track change.
- **Era dial** — All / Vintage / 90s / 2000s / Latest (filtered by real release year)
- **Time-of-day mood** — auto-shifts vibe (morning ragas → sunset melodies → late-night chill)
- **Mystery reveal** — title hidden until song fades in
- **Heart bursts** when you like a song
- **MediaSession** — lock-screen art, headphone buttons, media keys
- **Keyboard** — `Space` play · `→` next · `←` prev · `S` shuffle · `L` like · `M` mystery
- **Reduced motion** respected

## Source

**JioSaavn** for full-length Telugu film songs. Daily GitHub Action runs `scripts/refresh_catalog.py` which:
1. Searches JioSaavn across ~110 diverse queries (composers, singers, movies, eras)
2. Expands the movie albums behind those hits to pull whole soundtracks
3. Filters to film songs only (label allowlist + non-film keyword exclusion)
4. DES-decrypts each `encrypted_media_url` to the direct CDN URL on `aac.saavncdn.com`
5. Probes LRClib for synced lyrics and inlines them into the catalog
6. Commits `catalog.json` with full metadata + audio URL + movie poster + lyrics

The catalog grows past 10k songs, so the script is **wall-clock budgeted**
(`TIME_BUDGET_MIN`, default 40m): every phase — search, album expansion,
detail fetch, lyrics probe — is shuffled and capped so a run always finishes
inside the CI window and commits. Coverage accumulates across daily runs
rather than trying (and timing out) to do everything at once.

Frontend reads `catalog.json` once and plays via plain HTML5 `<audio>` — no API keys, no IFrame, no auth. CORS is allowed `*` on JioSaavn's CDN, so it works on file://, GitHub Pages, anywhere.

## AI recommendations (optional)

The frontend has a Groq-powered "smart shuffle" that learns your taste from the songs you ❤️. By default it uses a heuristic scorer that runs entirely in-browser. To enable Groq:

1. Get a free Groq API key from [console.groq.com](https://console.groq.com)
2. Deploy the Cloudflare Worker proxy in `worker/` (see `worker/README.md`)
3. Set `AI_WORKER_URL` in `index.html` to your Worker URL
4. AI activates once you have 5+ liked songs

Heuristic fallback is always active — even with no AI, the recommender weights candidates by artist match (3×), movie match (2×), era match (1.5×), year proximity (1×), and history penalty (-4×).

## Run

Just open `index.html` in any browser. Or serve it:
```
python -m http.server 8000
```

## Stack

Single self-contained `index.html` — vanilla JS, vanilla CSS, no build step. The
only runtime deps are loaded from CDN: CryptoJS (DES decrypt for live search)
and Three.js (the 3D turntable, via import map — optional, fails soft). Hosts
as-is on GitHub Pages, Cloudflare Pages, Netlify, Vercel.
