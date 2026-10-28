/* WRD cloud captions · Cloudflare Worker
   - Serves the WRD site (index.html, keys.json, ...) exactly as before.
   - POST /api/captions  : one short piece of speech (16 kHz mono WAV, base64) -> timed words from Whisper Large-v3 Turbo.
   - GET  /api/captions  : how many cloud minutes this key has left today.
   Only active WRD license keys work (checked against keys.json), each key has a daily minute cap (set in the Keys admin),
   and when Cloudflare's free daily allowance runs out WRD quietly switches back to on-device captions. */

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_SECONDS = 60;            // longest single piece WRD may send
const LIST_TTL = 60 * 1000;        // re-read keys.json at most once a minute
const DEFAULT_CAPS = { trial: 10, monthly: 60, yearly: 90, life: 0 };   // minutes per day, 0 = unlimited
const ALLOWED_HOSTS = [/^wrdmotion\.com$/, /^www\.wrdmotion\.com$/, /\.workers\.dev$/, /^localhost$/, /^127\.0\.0\.1$/];

let LIST = null, LIST_AT = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/captions' || url.pathname === '/api/captions/') return captions(request, env, url);
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  }
};

/* ---------- helpers ---------- */
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra) });
}
function originOk(request) {
  const o = request.headers.get('origin');
  if (!o) return true;                      // same-origin GETs from the page itself
  try { const h = new URL(o).hostname; return ALLOWED_HOSTS.some(r => r.test(h)); } catch (e) { return false; }
}
function corsFor(request) {
  const o = request.headers.get('origin');
  return o ? { 'access-control-allow-origin': o, 'vary': 'origin', 'access-control-allow-headers': 'content-type,x-wrd-token,x-wrd-lang,x-wrd-prompt', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '86400' } : {};
}
function b64u(buf) {
  const a = new Uint8Array(buf); let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha(text) { return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
function today() { return new Date().toISOString().slice(0, 10); }   // the daily cap resets at midnight UTC
function secsUntilReset() { const n = new Date(); return Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n) / 1000); }

async function getList(env, request) {
  if (LIST && Date.now() - LIST_AT < LIST_TTL) return LIST;
  const r = await env.ASSETS.fetch(new Request(new URL('/keys.json', request.url).toString()));
  if (!r.ok) throw new Error('keys.json ' + r.status);
  const j = await r.json();
  const cloud = j.cloud || {};
  const map = new Map();
  (cloud.k || []).forEach(row => { if (Array.isArray(row) && row[0]) map.set(row[0], { plan: row[1] || 'life', exp: row[2] || null, min: +row[3] || 0 }); });
  LIST = { on: cloud.on !== false, caps: Object.assign({}, DEFAULT_CAPS, cloud.caps || {}), keys: map };
  LIST_AT = Date.now();
  return LIST;
}

/* who is asking, and how many minutes do they get today */
async function account(request, env) {
  const tok = (request.headers.get('x-wrd-token') || '').trim();
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(tok)) return { err: json({ ok: false, error: 'Sign in to WRD to use cloud captions.', code: 'auth' }, 401) };
  const L = await getList(env, request);
  if (!L.on) return { err: json({ ok: false, error: 'Cloud captions are switched off right now.', code: 'off', fallback: true }, 503) };
  const id = await sha('cloud|' + tok);
  const k = L.keys.get(id);
  if (!k) return { err: json({ ok: false, error: 'This license can’t use cloud captions.', code: 'auth' }, 403) };
  if (k.exp && today() > k.exp) return { err: json({ ok: false, error: 'This license has ended.', code: 'auth' }, 403) };
  if (k.min < 0) return { err: json({ ok: false, error: 'Cloud captions are off for this license.', code: 'blocked', fallback: true }, 403) };
  const capMin = k.min > 0 ? k.min : (+L.caps[k.plan] || 0);
  const usageKey = 'u:' + today() + ':' + id;
  const used = env.USAGE ? (+(await env.USAGE.get(usageKey)) || 0) : 0;
  return { id, capSec: capMin > 0 ? capMin * 60 : 0, used, usageKey };
}
function meter(acc) {
  const left = acc.capSec ? Math.max(0, acc.capSec - acc.used) : null;
  return { usedMin: Math.round(acc.used / 6) / 10, capMin: acc.capSec ? acc.capSec / 60 : 0, leftMin: left == null ? null : Math.floor(left / 6) / 10, resetsIn: secsUntilReset() };
}

/* length of a base64 16 kHz mono 16-bit WAV, read from its header */
function wavSeconds(b64) {
  const head = atob(b64.slice(0, 64));
  if (head.slice(0, 4) !== 'RIFF' || head.slice(8, 12) !== 'WAVE') return -1;
  const u = i => head.charCodeAt(i), u16 = i => u(i) | (u(i + 1) << 8), u32 = i => (u(i) | (u(i + 1) << 8) | (u(i + 2) << 16)) + u(i + 3) * 16777216;
  const ch = u16(22), sr = u32(24), bits = u16(34);
  if (u16(20) !== 1 || ch !== 1 || sr !== 16000 || bits !== 16) return -1;
  const bytes = Math.floor(b64.replace(/=+$/, '').length * 3 / 4) - 44;      // real size, not what the header claims
  return Math.max(0, bytes / (sr * 2));
}

/* Whisper output -> [{w,s,e}] in seconds */
function toWords(out) {
  const words = [];
  (out && out.segments || []).forEach(sg => {
    if (Array.isArray(sg.words) && sg.words.length) {
      sg.words.forEach(w => { const t = String(w.word || '').trim(); if (t) words.push({ w: t, s: +w.start || 0, e: +w.end || (+w.start || 0) + .3 }); });
    } else {
      const parts = String(sg.text || '').trim().split(/\s+/).filter(Boolean), s = +sg.start || 0, e = +sg.end || s + parts.length * .3, d = (e - s) / Math.max(1, parts.length);
      parts.forEach((t, i) => words.push({ w: t, s: s + i * d, e: s + (i + 1) * d, seg: 1 }));
    }
  });
  if (!words.length && out && out.text) String(out.text).trim().split(/\s+/).filter(Boolean).forEach((t, i) => words.push({ w: t, s: i * .35, e: i * .35 + .3, seg: 1 }));
  return words;
}

/* ---------- the endpoint ---------- */
async function captions(request, env, url) {
  const cors = corsFor(request);
  if (!originOk(request)) return json({ ok: false, error: 'not allowed' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!env.AI) return json({ ok: false, error: 'Cloud captions aren’t set up yet.', code: 'setup', fallback: true }, 503, cors);
  let acc;
  try { acc = await account(request, env); } catch (e) { return json({ ok: false, error: 'Couldn’t check your license.', code: 'list', fallback: true }, 503, cors); }
  if (acc.err) { const r = acc.err; Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); return r; }

  if (request.method === 'GET') return json(Object.assign({ ok: true, model: 'Whisper Large-v3 Turbo' }, meter(acc)), 200, cors);
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors);

  const len = +(request.headers.get('content-length') || 0);
  if (len > (MAX_SECONDS * 32000 + 44) * 1.4 + 1024) return json({ ok: false, error: 'Piece too long.', code: 'size' }, 413, cors);
  const audio = (await request.text()).trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(audio.slice(0, 200))) return json({ ok: false, error: 'Bad audio.', code: 'audio' }, 400, cors);
  const secs = wavSeconds(audio);
  if (secs < 0) return json({ ok: false, error: 'Bad audio.', code: 'audio' }, 400, cors);
  if (secs > MAX_SECONDS + .5) return json({ ok: false, error: 'Piece too long.', code: 'size' }, 413, cors);
  if (secs < .2) return json(Object.assign({ ok: true, words: [] }, meter(acc)), 200, cors);
  if (acc.capSec && acc.used >= acc.capSec)
    return json(Object.assign({ ok: false, error: 'You’ve used today’s cloud caption minutes.', code: 'cap', fallback: true }, meter(acc)), 429, cors);

  const input = { audio, task: 'transcribe', vad_filter: false, condition_on_previous_text: false, hallucination_silence_threshold: 2 };
  const lang = (request.headers.get('x-wrd-lang') || '').trim().toLowerCase();
  if (/^[a-z]{2,3}$/.test(lang)) input.language = lang;
  let prompt = ''; try { prompt = decodeURIComponent(request.headers.get('x-wrd-prompt') || ''); } catch (e) {}
  prompt = prompt.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  if (prompt) input.initial_prompt = prompt;

  let out;
  try { out = await env.AI.run(MODEL, input); }
  catch (e) {
    const m = String(e && e.message || e);
    const quota = /4006|neuron|allocation|quota|limit/i.test(m);
    return json({ ok: false, error: quota ? 'Cloud captions are busy today.' : 'Cloud captions had a hiccup.', code: quota ? 'quota' : 'ai', fallback: true, detail: m.slice(0, 160) }, 503, cors);
  }
  acc.used += secs;
  if (env.USAGE) await env.USAGE.put(acc.usageKey, String(Math.round(acc.used * 10) / 10), { expirationTtl: 3 * 86400 });
  return json(Object.assign({ ok: true, words: toWords(out), text: (out && out.text) || '', secs: Math.round(secs * 10) / 10 }, meter(acc)), 200, cors);
}
