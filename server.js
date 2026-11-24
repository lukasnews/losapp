'use strict';
// Einstiegspunkt: HTTP-Server, Login, REST-API, WebSocket für Dashboard und Overlay.
try { process.loadEnvFile?.('.env'); } catch { /* keine .env vorhanden */ }

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./src/store');
const twitch = require('./src/twitch');
const chat = require('./src/chat');
const checker = require('./src/checker');
const { Giveaway } = require('./src/giveaway');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = BASE_URL + '/auth/callback';
const ALLOWED_LOGIN = (process.env.ALLOWED_LOGIN || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECURE_COOKIE = BASE_URL.startsWith('https://');

const config = store.load('config', { overlayKey: crypto.randomBytes(12).toString('hex') });
store.save('config', config);

const giveaway = new Giveaway({ checker });

// ---------- Sitzungen ----------
const sessions = new Map(); // sid -> { login, exp }
const SESSION_MS = 7 * 86_400_000;

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}
function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIE ? '; Secure' : ''}`;
}
function getSession(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(sid); return null; }
  return s;
}
function createSession(res, login) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { login, exp: Date.now() + SESSION_MS });
  res.append('Set-Cookie', cookie('sid', sid, SESSION_MS / 1000));
}
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/', (req, res) => res.redirect(getSession(req) ? '/dashboard' : '/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => {
  if (!getSession(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/overlay', (req, res) => {
  if (!safeEqual(req.query.key || '', config.overlayKey)) return res.status(403).send('Ungültiger Overlay-Schlüssel');
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));

app.get('/auth/info', (req, res) => {
  res.json({ twitchConfigured: twitch.configured(), passwordLogin: Boolean(ADMIN_PASSWORD), connected: twitch.connected(), login: twitch.auth.login });
});

app.get('/auth/login', (req, res) => {
  if (!twitch.configured()) return res.status(500).send('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET fehlen in der .env');
  const state = crypto.randomBytes(16).toString('hex');
  res.append('Set-Cookie', cookie('oauth_state', state, 600));
  res.redirect(twitch.authorizeUrl(REDIRECT_URI, state));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/login?error=' + encodeURIComponent(String(req.query.error_description || error)));
  if (!state || !safeEqual(state, parseCookies(req.headers.cookie).oauth_state || '')) {
    return res.redirect('/login?error=' + encodeURIComponent('Ungültiger Login-Status, bitte erneut versuchen'));
  }
  try {
    const { token, user } = await twitch.exchangeCode(String(code), REDIRECT_URI);
    const login = user.login.toLowerCase();
    const owner = ALLOWED_LOGIN || twitch.auth.login;
    if (owner && owner !== login) {
      return res.redirect('/login?error=' + encodeURIComponent(`Nur der Kanal "${owner}" darf sich anmelden.`));
    }
    twitch.setAccount(token, user);
    twitch.clearCache();
    createSession(res, login);
    chat.connect();
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/login?error=' + encodeURIComponent('Twitch-Login fehlgeschlagen: ' + err.message));
  }
});

const attempts = new Map();
app.post('/auth/password', (req, res) => {
  const ip = req.socket.remoteAddress;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60_000) Object.assign(a, { n: 0, t: Date.now() });
  if (a.n >= 10) return res.status(429).json({ error: 'Zu viele Versuche, später erneut probieren' });
  if (!ADMIN_PASSWORD || !safeEqual(req.body?.password || '', ADMIN_PASSWORD)) {
    a.n++;
    attempts.set(ip, a);
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  attempts.delete(ip);
  createSession(res, 'admin');
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  sessions.delete(sid);
  res.append('Set-Cookie', cookie('sid', '', 0));
  res.json({ ok: true });
});

// ---------- API (nur eingeloggt) ----------
const api = express.Router();
api.use((req, res, next) => {
  if (!getSession(req)) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON erwartet' });
  next();
});
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

api.get('/state', (req, res) => res.json(adminState()));
api.post('/settings', (req, res) => { giveaway.updateSettings(req.body); res.json({ ok: true }); });
api.post('/open', (req, res) => { giveaway.open(); res.json({ ok: true }); });
api.post('/close', (req, res) => { giveaway.close(); res.json({ ok: true }); });
api.post('/reset', (req, res) => { giveaway.reset(); res.json({ ok: true }); });
api.post('/draw', wrap(async (req, res) => res.json({ winner: await giveaway.draw() })));
api.post('/reroll', wrap(async (req, res) => res.json({ winner: await giveaway.reroll(req.body.login) })));
api.post('/confirm', (req, res) => { giveaway.confirmWinner(); res.json({ ok: true }); });
api.post('/remove', (req, res) => { giveaway.removeEntry(req.body.login); res.json({ ok: true }); });
api.post('/history/clear', (req, res) => { giveaway.history = []; giveaway.persist(); giveaway.changed(); res.json({ ok: true }); });

// Echten Twitch-Nutzer gegen die aktuellen Bedingungen prüfen
api.post('/check', wrap(async (req, res) => {
  const login = String(req.body.login || '').trim().replace(/^@/, '').toLowerCase();
  if (!login) return res.status(400).json({ error: 'Benutzername fehlt' });
  if (!twitch.connected()) return res.status(400).json({ error: 'Nicht mit Twitch verbunden – nutze den Testmodus' });
  const user = await twitch.getUserByLogin(login);
  if (!user) return res.status(404).json({ error: `Twitch-Nutzer "${login}" nicht gefunden` });
  const result = await giveaway.evaluate({ id: user.id, login: user.login, displayName: user.display_name });
  res.json({ user: { login: user.login, displayName: user.display_name }, ...result });
}));

// Testmodus: simulierte Nutzer mit frei wählbaren Eigenschaften
function simUser(b) {
  const login = String(b.login || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
  if (!login) throw new Error('Ungültiger Benutzername');
  return {
    id: 'sim-' + login,
    login,
    displayName: b.displayName || login,
    badges: {},
    sim: {
      follows: Boolean(b.follows),
      followDays: Number(b.followDays) || 0,
      subTier: Number(b.subTier) || 0,
      vip: Boolean(b.vip),
      mod: Boolean(b.mod),
      accountAgeDays: Number(b.accountAgeDays) || 0,
    },
  };
}
api.post('/sim/check', wrap(async (req, res) => res.json(await giveaway.evaluate(simUser(req.body)))));
api.post('/sim/chat', wrap(async (req, res) => {
  await giveaway.handleMessage(simUser(req.body), String(req.body.message || ''));
  res.json({ ok: true, status: giveaway.status });
}));
api.post('/sim/bulk', wrap(async (req, res) => {
  if (giveaway.status !== 'open') return res.status(400).json({ error: 'Erst die Teilnahme öffnen' });
  const n = Math.min(500, Math.max(1, Number(req.body.count) || 10));
  const r = () => Math.random();
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const u = simUser({
      login: 'test_' + crypto.randomBytes(3).toString('hex'),
      follows: r() < 0.85,
      followDays: Math.floor(r() * 400),
      subTier: r() < 0.7 ? 0 : r() < 0.8 ? 1 : r() < 0.6 ? 2 : 3,
      vip: r() < 0.05,
      mod: r() < 0.03,
      accountAgeDays: Math.floor(r() * 2000),
    });
    jobs.push(giveaway.handleMessage(u, giveaway.settings.keyword));
  }
  await Promise.all(jobs);
  res.json({ ok: true });
}));

api.post('/twitch/disconnect', wrap(async (req, res) => {
  await chat.disconnect();
  twitch.logout();
  broadcastAdmin();
  res.json({ ok: true });
}));
api.post('/chat/reconnect', wrap(async (req, res) => { await chat.connect(); res.json({ ok: true }); }));
api.post('/chat/test', wrap(async (req, res) => { await chat.say(String(req.body.message || 'Test von der Auslosungs-App ✅')); res.json({ ok: true }); }));
api.post('/overlay/rotate', (req, res) => {
  config.overlayKey = crypto.randomBytes(12).toString('hex');
  store.save('config', config);
  for (const ws of overlayClients) ws.close();
  broadcastAdmin();
  res.json({ ok: true });
});
app.use('/api', api);

function adminState() {
  return {
    ...giveaway.snapshot(),
    twitch: { configured: twitch.configured(), connected: twitch.connected(), login: twitch.auth.login, displayName: twitch.auth.displayName },
    chatStatus: chat.status,
    overlayUrl: `${BASE_URL}/overlay?key=${config.overlayKey}`,
  };
}

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const adminClients = new Set();
const overlayClients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('overlay') !== null) {
    if (!safeEqual(url.searchParams.get('overlay'), config.overlayKey)) return ws.close(4003, 'forbidden');
    overlayClients.add(ws);
    ws.on('close', () => overlayClients.delete(ws));
    ws.send(JSON.stringify({ type: 'state', data: giveaway.publicSnapshot() }));
  } else {
    if (!getSession(req)) return ws.close(4001, 'unauthorized');
    adminClients.add(ws);
    ws.on('close', () => adminClients.delete(ws));
    ws.send(JSON.stringify({ type: 'state', data: adminState() }));
  }
  ws.on('error', () => {});
});

const send = (set, msg) => {
  const s = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
};
function broadcastAdmin() { send(adminClients, { type: 'state', data: adminState() }); }

// Zustandsupdates bündeln (bei vielen Teilnahmen gleichzeitig)
let pendingState = null;
giveaway.on('state', () => {
  if (pendingState) return;
  pendingState = setTimeout(() => {
    pendingState = null;
    broadcastAdmin();
    send(overlayClients, { type: 'state', data: giveaway.publicSnapshot() });
  }, 150);
});
for (const ev of ['drawn', 'entry', 'confirmed', 'expired']) {
  giveaway.on(ev, (data) => {
    send(overlayClients, { type: ev, data });
    send(adminClients, { type: ev, data });
  });
}
giveaway.on('say', (text) => chat.say(text));
chat.on('message', (user, text) => giveaway.handleMessage(user, text).catch((e) => console.error(e)));
chat.on('status', broadcastAdmin);

server.listen(PORT, () => {
  console.log(`Auslosungs-App läuft auf ${BASE_URL}`);
  console.log(`Overlay-URL (OBS Browserquelle): ${BASE_URL}/overlay?key=${config.overlayKey}`);
  if (!twitch.configured()) console.log('Hinweis: Twitch nicht konfiguriert – nur Testmodus (ADMIN_PASSWORD setzen).');
  if (twitch.connected()) chat.connect();
});
