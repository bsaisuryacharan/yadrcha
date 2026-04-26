# Yadrcha AI Worker

A 60-line Cloudflare Worker that proxies the frontend's recommendation requests to Groq, keeping the API key server-side.

## What it does

```
browser ─POST→ this worker ─POST→ Groq llama-3.1-8b-instant ─→ chosen song id ─→ browser
```

The frontend sends a compact taste profile (top artists/eras/movies, year centroid) plus 20 era-filtered candidate songs. Groq picks one. ~600 tokens per call → ~790 shuffles/day on the free tier.

## Deploy

```bash
# Once: install wrangler and login to Cloudflare
npm i -g wrangler
wrangler login

# Get a free Groq API key from https://console.groq.com
cd worker
wrangler secret put GROQ_API_KEY
# (paste the key when prompted)

wrangler deploy
```

You'll get a URL like `https://yadrcha-ai.<your-subdomain>.workers.dev`.

## Wire it to the frontend

In `index.html`, find:

```js
const AI_WORKER_URL = ''; // e.g. 'https://yadrcha-ai.username.workers.dev'
```

Set it to your Worker URL. Commit + push. AI recommendations activate after the user has 5+ liked songs.

## Quota math

- Groq free tier on `llama-3.1-8b-instant`: 14,400 RPD, 500K TPD, 30 RPM.
- ~630 tokens per recommendation call.
- Practical ceiling: ~790 AI-recommended shuffles per day across the whole user base.
- Hitting the limit is non-fatal — the frontend silently falls back to a heuristic scorer (~80% as good).

## Hardening (optional)

The worker already has an `Origin` allowlist (only `https://bsaisuryacharan.github.io`). For extra protection, add a per-IP token bucket using a Cloudflare KV namespace:

```toml
# wrangler.toml
[[kv_namespaces]]
binding = "RATE"
id = "<your-kv-id>"
```

Then in `yadrcha-ai.ts`, before calling Groq, count requests per `cf-connecting-ip` over a 1-hour window and 429 anyone over 60.
