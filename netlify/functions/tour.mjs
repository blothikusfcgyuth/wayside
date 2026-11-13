import { getStore } from '@netlify/blobs';

// Bump this to rewrite every tour (for example after improving the prompt).
const VERSION = 'v1';

const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese' };

const SYSTEM = `You write audio walking-tour scripts that are read aloud to someone standing at a place.

Rules:
- Use ONLY facts found in the SOURCE. Never add dates, names, numbers, quotes or anecdotes that are not there. If unsure, leave it out.
- Skip opening hours, prices, current events and anything that changes over time.
- Voice: a warm storyteller. Second person, present tense, short sentences. Be vivid by telling the listener what to look at, never by inventing sounds, smells or feelings.
- Write 3 or 4 chapters of 100 to 160 words each. Each chapter belongs to a spot where the listener might be (for example "From the steps", "Walking the outside", "Inside"). Adapt the spots to the place; if it has no interior, use viewpoints or stages of a short walk.
- Each chapter has a "cue": one short sentence telling the listener where to stand or what to look at.
- No markdown, lists, headings or emojis in the text. Write years and numbers the way they sound when spoken.
- Write in the requested language.
- Output ONLY JSON in this shape: {"chapters":[{"title":"","cue":"","text":""}]}`;

const CACHE = {
  'cache-control': 'public, max-age=0, must-revalidate',
  // Netlify's CDN also keeps each tour for 30 days, which saves function runs
  'netlify-cdn-cache-control': 'public, s-maxage=2592000, stale-while-revalidate=86400',
};

const json = (o, s = 200, h = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...h } });

const wiki = async (lang, params) => {
  const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?format=json&${params}`, {
    headers: { 'user-agent': 'Wayside/1.0 (audio tour app)' },
  });
  return r.json();
};

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const title = (q.get('title') || '').trim().slice(0, 120);
  const lang = q.get('lang') || 'en';
  if (!title || !LANGS[lang]) return json({ error: 'Bad request' }, 400);

  // 1. Identify the Wikipedia page (cheap lookup). Its ID is the cache key,
  //    so different spellings of the same place share one saved tour.
  let page;
  try {
    const w = await wiki(lang, `action=query&redirects=1&prop=info&inprop=url&titles=${encodeURIComponent(title)}`);
    page = Object.values(w.query?.pages || {})[0];
  } catch (e) {
    return json({ error: 'Wikipedia unavailable' }, 502);
  }
  if (!page || page.missing !== undefined || !page.pageid) return json({ error: 'Page not found' }, 404);

  const key = `${VERSION}/${lang}/${page.pageid}`;
  let store = null;
  try { store = getStore('tours'); } catch (e) { /* no store available (for example local testing) */ }

  // 2. Already written? Serve the saved tour without calling Claude.
  if (store) {
    try {
      const saved = await store.get(key, { type: 'json' });
      if (saved) return json(saved, 200, CACHE);
    } catch (e) { /* fall through and write it */ }
  }

  // 3. First request for this place: get the article text and write the tour.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'Missing ANTHROPIC_API_KEY' }, 500);

  let text = '';
  try {
    const w = await wiki(lang, `action=query&prop=extracts&explaintext=1&exsectionformat=plain&pageids=${page.pageid}`);
    text = (Object.values(w.query?.pages || {})[0]?.extract || '').slice(0, 14000);
  } catch (e) {
    return json({ error: 'Wikipedia unavailable' }, 502);
  }
  if (text.length < 300) return json({ error: 'Not enough source text' }, 404);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
        max_tokens: 2500,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Language: ${LANGS[lang]}\nPlace: ${page.title}\n\nSOURCE (Wikipedia, CC BY-SA):\n${text}` }],
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || r.status);
    const raw = (d.content || []).map((b) => b.text || '').join('').replace(/```json|```/g, '').trim();
    const chapters = (JSON.parse(raw).chapters || [])
      .filter((c) => c && typeof c.text === 'string' && c.text.length > 40)
      .slice(0, 5)
      .map((c) => ({ title: String(c.title || '').slice(0, 80), cue: String(c.cue || '').slice(0, 200), text: c.text }));
    if (!chapters.length) throw new Error('empty');

    const result = { title: page.title, url: page.fullurl, lang, chapters, generatedAt: new Date().toISOString() };
    if (store) {
      try { await store.setJSON(key, result); } catch (e) { /* still return the tour */ }
    }
    return json(result, 200, CACHE);
  } catch (e) {
    return json({ error: 'Could not write the tour' }, 502);
  }
};

export const config = { path: '/api/tour' };
