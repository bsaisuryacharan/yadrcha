/**
 * Yadrcha — Cloudflare Worker.
 * Endpoints:
 *   POST /                   AI recommendation (Groq)
 *   GET  /search?q=...       JioSaavn search proxy → top Telugu results
 *   GET  /play?id=...        Song details with DECRYPTED media URL
 *   POST /translate          English-to-Telugu lyrics translation (Groq)
 *
 * Note: this worker does NOT decrypt the media URL itself — Cloudflare's
 * node:crypto polyfill is unreliable for DES-ECB. Instead /play returns
 * the raw encrypted_media_url and the browser decrypts via a small
 * inline DES routine (see frontend).
 */
interface Env { GROQ_API_KEY: string; }

const ALLOWED_ORIGIN = 'https://bsaisuryacharan.github.io';
const corsBase: HeadersInit = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const SAAVN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  'Referer': 'https://www.jiosaavn.com/',
  'Accept': 'application/json,text/javascript,*/*;q=0.9',
};

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsBase, 'Content-Type': 'application/json' },
  });

async function jioCall(call: string, params: Record<string, string>): Promise<any> {
  const u = new URL('https://www.jiosaavn.com/api.php');
  u.searchParams.set('__call', call);
  u.searchParams.set('_format', 'json');
  u.searchParams.set('_marker', '0');
  u.searchParams.set('ctx', 'web6dot0');
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString(), { headers: SAAVN_HEADERS });
  if (!r.ok) return null;
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { const i = text.indexOf('{'); return i >= 0 ? JSON.parse(text.slice(i)) : null; }
}

function cleanMovie(s: string): string {
  if (!s) return '';
  return s
    .replace(/\s*\([^)]*soundtrack[^)]*\)\s*$/i, '')
    .replace(/\s*-\s*single\s*$/i, '')
    .replace(/\s*-\s*ep\s*$/i, '')
    .trim();
}

function hdImage(u: string): string {
  return u ? u.replace(/(\d{2,4})x\1/, '500x500') : u;
}

function htmlDecode(s: string): string {
  if (!s) return '';
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/* ---------- /search?q=... — Telugu films, popular first ---------- */
async function handleSearch(url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length < 2) return json({ results: [] });
  const data = await jioCall('search.getResults', { q, p: '1', n: '30' });
  const arr: any[] = data?.results || [];
  const out = arr
    .filter((s) => (s.language || '').toLowerCase() === 'telugu')
    .map((s) => ({
      id: s.id,
      title: htmlDecode(s.song || ''),
      artist: htmlDecode(s.singers || s.primary_artists || ''),
      movie: cleanMovie(htmlDecode(s.album || '')),
      year: parseInt(s.year, 10) || null,
      cover: hdImage(s.image || ''),
      plays: parseInt(s.play_count, 10) || 0,
    }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 12);
  return json({ results: out });
}

/* ---------- /play?id=... — full song metadata + encrypted URL ---------- */
async function handlePlay(url: URL): Promise<Response> {
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return json({ error: 'id required' }, 400);
  const data = await jioCall('song.getDetails', { pids: id });
  const song = data?.songs?.[0];
  if (!song) return json({ error: 'song not found' }, 404);
  return json({
    id: song.id,
    title: htmlDecode(song.song || ''),
    artist: htmlDecode(song.singers || song.primary_artists || ''),
    movie: cleanMovie(htmlDecode(song.album || '')),
    year: parseInt(song.year, 10) || null,
    cover: hdImage(song.image || ''),
    encryptedUrl: song.encrypted_media_url,
    duration: parseInt(song.duration, 10) || 240,
  });
}

/* ---------- POST /translate — English lyrics → Telugu (Groq) ---------- */
async function handleTranslate(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { text?: string };
  const text = (body.text || '').trim();
  if (!text || text.length < 2) return json({ translation: '' });
  if (text.length > 6000) return json({ error: 'text too long' }, 400);
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content:
            'Translate the following English song lyrics to Telugu in native Telugu script. ' +
            'Preserve the EXACT line count and order — every input line maps to one output line. ' +
            'Output ONLY the Telugu translation, no headers, no explanations, no romanization.',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!groqRes.ok) return json({ error: 'translate failed' }, 502);
  const data = await groqRes.json() as any;
  const out = data.choices?.[0]?.message?.content || '';
  return json({ translation: out.trim() });
}

/* ---------- POST / — AI recommendation (existing) ---------- */
const REC_SYSTEM =
  "You are a Telugu music recommender. Given a user's taste profile and a candidate list, " +
  'pick the ONE song the user is most likely to enjoy next. Strictly avoid IDs in RECENT_HISTORY_IDS. ' +
  'Return only JSON: {"id":"<candidate_id>","reason":"<5-8 words>"}.';

async function handleRecommend(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as any;
  const candLines = body.candidates
    .map((c: any) => `${c.id} | ${c.title} | ${c.movie} | ${c.artist} | ${c.year}`)
    .join('\n');
  const userMsg =
    `TASTE:\nfav_artists: [${body.taste.artists.join(', ')}]\n` +
    `fav_eras: [${body.taste.eras.join(', ')}]\nfav_movies: [${body.taste.movies.join(', ')}]\n` +
    `year_centroid: ${body.taste.yearCentroid}\nliked_count: ${body.taste.likedCount}\n\n` +
    `RECENT_HISTORY_IDS: [${body.history.join(', ')}]\nCURRENT_SONG: ${JSON.stringify(body.currentSong)}\n\n` +
    `CANDIDATES (${body.candidates.length}):\n${candLines}\n\nReturn JSON now.`;
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      temperature: 0.4,
      max_tokens: 60,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REC_SYSTEM },
        { role: 'user', content: userMsg },
      ],
    }),
  });
  if (!groqRes.ok) return json({ error: 'upstream' }, 502);
  const data = await groqRes.json() as any;
  let parsed: any;
  try { parsed = JSON.parse(data.choices[0].message.content); }
  catch { return json({ error: 'parse' }, 502); }
  return json({ id: parsed.id, reason: parsed.reason || '' });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsBase });
    if (req.headers.get('Origin') !== ALLOWED_ORIGIN)
      return new Response('Forbidden', { status: 403, headers: corsBase });
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/search') return handleSearch(url);
      if (req.method === 'GET' && url.pathname === '/play') return handlePlay(url);
      if (req.method === 'POST' && url.pathname === '/translate') return handleTranslate(req, env);
      if (req.method === 'POST' && url.pathname === '/') return handleRecommend(req, env);
      return new Response('Not found', { status: 404, headers: corsBase });
    } catch (e: any) {
      return json({ error: 'internal', detail: String(e).slice(0, 200) }, 500);
    }
  },
};
