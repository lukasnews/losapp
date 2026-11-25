// Losfee · Instagram-Brücke (Cloudflare Worker)
//
// Empfängt Instagram-Direktnachrichten (und, falls freigeschaltet, Live-Kommentare) über die
// offizielle Instagram-API, prüft per „is_user_follow_business“, ob die Person dem Konto folgt,
// und legt sie im Losfee-Konto ab. Losfee zeigt sie dann live als Teilnehmer an.
//
// Einrichtung: siehe Anleitung in Losfee (Reiter Teilnehmer → Live-Teilnahme: Instagram).
// Geheime Werte NICHT hier eintragen, sondern in Cloudflare unter
// Einstellungen → Variablen und Geheimnisse:  IG_TOKEN  und  APP_SECRET  (Typ „Geheimnis“).

const CONFIG = {
  FIREBASE_PROJECT: '__FIREBASE_PROJECT__',
  FIREBASE_API_KEY: '__FIREBASE_API_KEY__',
  LOSFEE_UID: '__LOSFEE_UID__',
  INBOX_KEY: '__INBOX_KEY__',
  VERIFY_TOKEN: '__VERIFY_TOKEN__',
  KEYWORD: '__KEYWORD__', // leer = jede Nachricht zählt
  ACCOUNT: '__ACCOUNT__', // Instagram-Name des Streamers, nur für die Antworttexte
  REPLY: '__REPLY__', // 'ja' = automatisch per DM antworten
  GRAPH_VERSION: 'v23.0',
};

const GRAPH = () => `https://graph.instagram.com/${CONFIG.GRAPH_VERSION}`;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Meta prüft beim Einrichten die Webhook-Adresse
    if (url.pathname === '/webhook' && request.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === CONFIG.VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get('hub.challenge') || '') : new Response('Falscher Verify-Token', { status: 403 });
    }

    // Instagram meldet neue Nachrichten / Kommentare
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const raw = await request.text();
      if (env.APP_SECRET && !(await validSignature(raw, request.headers.get('x-hub-signature-256'), env.APP_SECRET))) {
        return new Response('Ungültige Signatur', { status: 401 });
      }
      let body;
      try { body = JSON.parse(raw); } catch { return new Response('Kein JSON', { status: 400 }); }
      ctx.waitUntil(handleWebhook(body, env).catch((e) => console.log('Fehler:', e.message)));
      return new Response('EVENT_RECEIVED');
    }

    // Status für Losfee (verrät keine Geheimnisse)
    if (url.pathname === '/' || url.pathname === '/status') {
      const out = { ok: true, app: 'losfee-instagram', tokenSet: Boolean(env.IG_TOKEN), secretSet: Boolean(env.APP_SECRET), keyword: CONFIG.KEYWORD };
      if (url.searchParams.get('key') === CONFIG.INBOX_KEY && env.IG_TOKEN) {
        const r = await fetch(`${GRAPH()}/me?fields=user_id,username&access_token=${encodeURIComponent(env.IG_TOKEN)}`);
        const d = await r.json().catch(() => ({}));
        out.account = d.username || null;
        if (!r.ok) out.tokenError = d.error?.message || `HTTP ${r.status}`;
      }
      return json(out);
    }

    // Instagram-Konto für Nachrichten an die App anmelden
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      if (url.searchParams.get('key') !== CONFIG.INBOX_KEY) return json({ ok: false, error: 'Falscher Schlüssel' }, 403);
      if (!env.IG_TOKEN) return json({ ok: false, error: 'IG_TOKEN fehlt in Cloudflare' }, 400);
      const r = await fetch(`${GRAPH()}/me/subscribed_apps?subscribed_fields=messages,live_comments&access_token=${encodeURIComponent(env.IG_TOKEN)}`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // live_comments braucht erweiterte Freigabe: notfalls nur Nachrichten
        const r2 = await fetch(`${GRAPH()}/me/subscribed_apps?subscribed_fields=messages&access_token=${encodeURIComponent(env.IG_TOKEN)}`, { method: 'POST' });
        const d2 = await r2.json().catch(() => ({}));
        return json({ ok: r2.ok, onlyMessages: r2.ok, result: d2, firstError: d.error?.message }, r2.ok ? 200 : 400);
      }
      return json({ ok: true, result: d });
    }

    return new Response('Nicht gefunden', { status: 404 });
  },
};

async function validSignature(raw, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function matchesKeyword(text) {
  const kw = (CONFIG.KEYWORD || '').trim().toLowerCase();
  if (!kw) return true;
  const t = String(text || '').trim().toLowerCase();
  return t === kw || t.startsWith(kw + ' ') || t.startsWith(kw + '!') || t.split(/\s+/).includes(kw);
}

async function handleWebhook(body, env) {
  for (const entry of body.entry || []) {
    // Direktnachrichten
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg || msg.is_echo || msg.is_deleted || !ev.sender?.id || ev.sender.id === entry.id) continue;
      if (!matchesKeyword(msg.text)) continue;
      const profile = await getProfile(ev.sender.id, env);
      if (!profile?.username) continue;
      const follows = typeof profile.is_user_follow_business === 'boolean' ? profile.is_user_follow_business : null;
      await saveToLosfee({ id: msg.mid || `dm_${ev.sender.id}_${ev.timestamp}`, h: profile.username, name: profile.username, text: msg.text || '', follows, src: 'dm' });
      if (CONFIG.REPLY === 'ja' && env.IG_TOKEN) await reply(ev.sender.id, follows, env);
    }
    // Live-Kommentare (nur mit erweiterter Freigabe von Meta)
    for (const ch of entry.changes || []) {
      if (ch.field !== 'live_comments' && ch.field !== 'comments') continue;
      const v = ch.value || {};
      if (!v.from?.username || !matchesKeyword(v.text)) continue;
      let follows = null;
      const profile = v.from.id ? await getProfile(v.from.id, env) : null;
      if (typeof profile?.is_user_follow_business === 'boolean') follows = profile.is_user_follow_business;
      await saveToLosfee({ id: `c_${v.id || v.from.id + '_' + Date.now()}`, h: v.from.username, name: v.from.username, text: v.text || '', follows, src: ch.field === 'live_comments' ? 'live' : 'comment' });
    }
  }
}

async function getProfile(igsid, env) {
  if (!env.IG_TOKEN) return null;
  const r = await fetch(`${GRAPH()}/${encodeURIComponent(igsid)}?fields=username,name,is_user_follow_business&access_token=${encodeURIComponent(env.IG_TOKEN)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.log('Profil nicht abrufbar:', d.error?.message || r.status); return null; }
  return d;
}

async function reply(igsid, follows, env) {
  const acc = CONFIG.ACCOUNT ? '@' + CONFIG.ACCOUNT.replace(/^@/, '') : 'dem Konto';
  const text = follows === false
    ? `Fast geschafft! Folge ${acc} und schreib dann nochmal „${CONFIG.KEYWORD || 'hier'}“, damit dein Los zählt.`
    : 'Du bist dabei ✅ Viel Glück!';
  await fetch(`${GRAPH()}/me/messages?access_token=${encodeURIComponent(env.IG_TOKEN)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  }).catch(() => {});
}

async function saveToLosfee({ id, h, name, text, follows, src }) {
  const docId = String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) || String(Date.now());
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT}/databases/(default)/documents/users/${CONFIG.LOSFEE_UID}/inbox?documentId=${encodeURIComponent(docId)}&key=${CONFIG.FIREBASE_API_KEY}`;
  const fields = {
    key: { stringValue: CONFIG.INBOX_KEY },
    platform: { stringValue: 'instagram' },
    h: { stringValue: String(h).toLowerCase().slice(0, 40) },
    name: { stringValue: String(name).slice(0, 40) },
    text: { stringValue: String(text).slice(0, 500) },
    follows: follows === null ? { nullValue: null } : { booleanValue: follows },
    src: { stringValue: src },
    at: { integerValue: String(Date.now()) },
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!r.ok && r.status !== 409) console.log('Speichern fehlgeschlagen:', r.status, await r.text());
}
