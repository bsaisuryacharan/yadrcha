/**
 * Yadrcha AI — Cloudflare Worker proxy for Groq.
 *
 * Why this exists:
 * - We don't want GROQ_API_KEY embedded in client-side JS.
 * - The frontend POSTs taste profile + 20 candidates here; this worker
 *   forwards to Groq with the secret key and returns the chosen song id.
 *
 * Deploy:
 *   npm i -g wrangler
 *   cd worker
 *   wrangler init --yes (if no wrangler.toml yet)
 *   wrangler secret put GROQ_API_KEY    # paste key from console.groq.com
 *   wrangler deploy
 *
 * After deploy you'll get a URL like https://yadrcha-ai.<you>.workers.dev
 * Set that URL as AI_WORKER_URL in index.html.
 */

interface Env {
  GROQ_API_KEY: string;
}

const ALLOWED_ORIGIN = 'https://bsaisuryacharan.github.io';

const SYSTEM_PROMPT =
  "You are a Telugu music recommender. Given a user's taste profile and a candidate list, " +
  "pick the ONE song the user is most likely to enjoy next. Strictly avoid IDs in RECENT_HISTORY_IDS. " +
  'Return only JSON: {"id":"<candidate_id>","reason":"<5-8 words>"}.';

const cors: HeadersInit = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST')
      return new Response('Method not allowed', { status: 405, headers: cors });
    if (req.headers.get('Origin') !== ALLOWED_ORIGIN)
      return new Response('Forbidden', { status: 403, headers: cors });

    const body = (await req.json()) as {
      currentSong: any;
      taste: { artists: string[]; movies: string[]; eras: string[]; yearCentroid: number; likedCount: number };
      history: string[];
      candidates: { id: string; title: string; movie: string; artist: string; year: number }[];
    };

    const candLines = body.candidates
      .map((c) => `${c.id} | ${c.title} | ${c.movie} | ${c.artist} | ${c.year}`)
      .join('\n');

    const userMsg =
      `TASTE:\n` +
      `fav_artists: [${body.taste.artists.join(', ')}]\n` +
      `fav_eras: [${body.taste.eras.join(', ')}]\n` +
      `fav_movies: [${body.taste.movies.join(', ')}]\n` +
      `year_centroid: ${body.taste.yearCentroid}\n` +
      `liked_count: ${body.taste.likedCount}\n\n` +
      `RECENT_HISTORY_IDS: [${body.history.join(', ')}]\n` +
      `CURRENT_SONG: ${JSON.stringify(body.currentSong)}\n\n` +
      `CANDIDATES (${body.candidates.length}):\n${candLines}\n\n` +
      `Return JSON now.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0.4,
        max_tokens: 60,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return new Response(JSON.stringify({ error: 'upstream', status: groqRes.status, detail: errText.slice(0, 300) }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const data = (await groqRes.json()) as any;
    let parsed: { id: string; reason?: string };
    try {
      parsed = JSON.parse(data.choices[0].message.content);
    } catch {
      return new Response(JSON.stringify({ error: 'parse', raw: data.choices?.[0]?.message?.content }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ id: parsed.id, reason: parsed.reason || '' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
