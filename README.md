# Yadrcha · Random Telugu Music

A one-tap shuffle player for random Telugu film music — old to latest. Press the green button, hear something. No login, no setup.

**Live: https://CharanBharathula.github.io/yadrcha/**

## Features

- **One-tap shuffle** — single big button, lean-back radio model
- **Phone-frame UI** on desktop, full-screen on mobile
- **Spinning vinyl** with movie poster as the center label, swinging tonearm
- **Era dial** — All / Vintage / 90s / 2000s / Latest (filtered by real release year)
- **Time-of-day mood** — auto-shifts vibe (morning ragas → sunset melodies → late-night chill)
- **Mystery reveal** — title hidden until song fades in
- **Heart bursts** when you like a song
- **MediaSession** — lock-screen art, headphone buttons, media keys
- **Keyboard** — `Space` play · `→` next · `←` prev · `S` shuffle · `L` like · `M` mystery
- **Reduced motion** respected

## Source

[Apple iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) — free, public, no API key, CORS-enabled. Catalogue is parallel-fetched from ~50 search terms (composers, singers, movies, eras) → deduped by `trackId` → strict-filtered to `primaryGenreName === "Telugu"` → 7-day localStorage cache.

30-second previews per Apple's terms. Real movie posters and metadata.

## Run

Just open `index.html` in any browser. Or serve it:
```
python -m http.server 8000
```

## Stack

Single self-contained `index.html` — vanilla JS, vanilla CSS, no build step, no dependencies. Hosts as-is on GitHub Pages, Cloudflare Pages, Netlify, Vercel.
