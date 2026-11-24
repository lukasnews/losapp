'use strict';
// Twitch Helix API + OAuth (Authorization Code Flow mit Refresh-Token).
const store = require('./store');

const CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

const SCOPES = [
  'chat:read',
  'chat:edit',
  'moderator:read:followers', // Follow prüfen + Follow-Dauer
  'channel:read:subscriptions', // Abo + Stufe prüfen
  'channel:read:vips', // VIP prüfen
  'moderation:read', // Moderator prüfen
];

const auth = store.load('auth', {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  userId: null,
  login: null,
  displayName: null,
});

const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
const connected = () => Boolean(auth.accessToken && auth.userId);

function authorizeUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    force_verify: 'true',
  });
  return 'https://id.twitch.tv/oauth2/authorize?' + p;
}

async function tokenRequest(params) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  if (!res.ok) throw new Error('Token-Anfrage fehlgeschlagen: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

function applyToken(t) {
  auth.accessToken = t.access_token;
  auth.refreshToken = t.refresh_token || auth.refreshToken;
  auth.expiresAt = Date.now() + (t.expires_in || 3600) * 1000;
  store.save('auth', auth);
}

async function exchangeCode(code, redirectUri) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  // Benutzer zum Token ermitteln, bevor wir ihn speichern
  const res = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: 'Bearer ' + t.access_token, 'Client-Id': CLIENT_ID },
  });
  const user = (await res.json()).data?.[0];
  if (!user) throw new Error('Twitch-Benutzer konnte nicht ermittelt werden');
  return { token: t, user };
}

function setAccount(token, user) {
  applyToken(token);
  auth.userId = user.id;
  auth.login = user.login;
  auth.displayName = user.display_name;
  store.save('auth', auth);
}

function logout() {
  Object.assign(auth, { accessToken: null, refreshToken: null, expiresAt: 0, userId: null, login: null, displayName: null });
  store.save('auth', auth);
}

let refreshing = null;
async function refresh() {
  if (!auth.refreshToken) throw new Error('Kein Refresh-Token – bitte neu mit Twitch verbinden');
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken })
    .then(applyToken)
    .finally(() => (refreshing = null));
  return refreshing;
}

async function getToken() {
  if (!auth.accessToken) throw new Error('Nicht mit Twitch verbunden');
  if (Date.now() > auth.expiresAt - 60_000) await refresh();
  return auth.accessToken;
}

async function helix(pathAndQuery, retry = true) {
  const token = await getToken();
  const res = await fetch('https://api.twitch.tv/helix/' + pathAndQuery, {
    headers: { Authorization: 'Bearer ' + token, 'Client-Id': CLIENT_ID },
  });
  if (res.status === 401 && retry) {
    await refresh();
    return helix(pathAndQuery, false);
  }
  if (!res.ok) throw new Error(`Twitch API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- Prüfungen (mit kurzem Cache, um Rate-Limits zu schonen) ----
const cache = new Map();
const TTL = 2 * 60_000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
const clearCache = () => cache.clear();

const b = () => auth.userId;

/** @returns {Promise<Date|null>} Follow-Zeitpunkt oder null */
const getFollow = (userId) =>
  cached('f' + userId, async () => {
    const r = await helix(`channels/followers?broadcaster_id=${b()}&user_id=${userId}`);
    return r.data?.[0]?.followed_at ?? null;
  });

/** @returns {Promise<0|1|2|3>} Abo-Stufe, 0 = kein Abo */
const getSubTier = (userId) =>
  cached('s' + userId, async () => {
    const r = await helix(`subscriptions?broadcaster_id=${b()}&user_id=${userId}`);
    const tier = r.data?.[0]?.tier;
    return tier ? Number(tier) / 1000 : 0;
  });

const isVip = (userId) =>
  cached('v' + userId, async () => {
    const r = await helix(`channels/vips?broadcaster_id=${b()}&user_id=${userId}`);
    return (r.data?.length ?? 0) > 0;
  });

const isMod = (userId) =>
  cached('m' + userId, async () => {
    const r = await helix(`moderation/moderators?broadcaster_id=${b()}&user_id=${userId}`);
    return (r.data?.length ?? 0) > 0;
  });

/** @returns {Promise<string|null>} Konto-Erstellungsdatum */
const getCreatedAt = (userId) =>
  cached('u' + userId, async () => {
    const r = await helix(`users?id=${userId}`);
    return r.data?.[0]?.created_at ?? null;
  });

const getUserByLogin = (login) =>
  cached('l' + login, async () => {
    const r = await helix(`users?login=${encodeURIComponent(login)}`);
    return r.data?.[0] ?? null;
  });

module.exports = {
  auth,
  configured,
  connected,
  authorizeUrl,
  exchangeCode,
  setAccount,
  logout,
  getToken,
  getFollow,
  getSubTier,
  isVip,
  isMod,
  getCreatedAt,
  getUserByLogin,
  clearCache,
};
