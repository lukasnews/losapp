'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (t) => new Date(t).toLocaleTimeString('de-DE');
const dateTime = (t) => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

let state = null;

// ---------- Hilfen ----------
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, body) {
  const res = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) location.href = '/login';
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
  return data;
}
const act = (path, body = {}) => api(path, body).catch((e) => toast(e.message, true));

// ---------- Einstellungen (Schema) ----------
const SCHEMA = [
  ['Allgemein', [
    ['title', 'text', 'Titel der Verlosung'],
    ['prize', 'text', 'Preis', 'z.B. "Steam-Key für XY"'],
    ['keyword', 'text', 'Schlüsselwort zum Mitmachen', 'Erstes Wort der Chat-Nachricht, z.B. !join'],
    ['leaveKeyword', 'text', 'Schlüsselwort zum Austreten', 'Leer lassen zum Deaktivieren'],
    ['entryDurationSec', 'number', 'Teilnahme-Dauer (Sekunden)', '0 = manuell schließen'],
    ['maxEntries', 'number', 'Max. Teilnehmer', '0 = unbegrenzt'],
    ['winnerCount', 'number', 'Anzahl Gewinner'],
  ]],
  ['Teilnahmebedingungen', [
    ['requireFollow', 'check', 'Muss dem Kanal folgen'],
    ['minFollowDays', 'number', 'Mindestens X Tage gefolgt', '0 = egal wie lange'],
    ['requireSub', 'check', 'Nur Abonnenten'],
    ['minSubTier', 'select', 'Mindest-Abostufe', '', [[1, 'Stufe 1'], [2, 'Stufe 2'], [3, 'Stufe 3']]],
    ['minAccountAgeDays', 'number', 'Twitch-Konto mind. X Tage alt', 'Schützt vor Zweit-/Fake-Konten. 0 = aus'],
    ['excludeBroadcaster', 'check', 'Streamer ausschließen'],
    ['excludeMods', 'check', 'Moderatoren ausschließen'],
    ['excludeVips', 'check', 'VIPs ausschließen'],
    ['excludeRecentWinners', 'number', 'Gewinner der letzten X Verlosungen ausschließen', '0 = aus'],
    ['blacklist', 'list', 'Sperrliste', 'Twitch-Namen, getrennt durch Komma oder Zeilenumbruch'],
    ['recheckOnDraw', 'check', 'Bedingungen beim Ziehen erneut prüfen', 'Wer zwischendurch entfolgt, wird disqualifiziert und es wird neu gezogen'],
  ]],
  ['Glückschance (Gewichtung)', [
    ['weightBase', 'number', 'Grundgewicht (alle)', 'Standard 1'],
    ['weightTier1', 'number', 'Multiplikator Abo Stufe 1', '1 = keine Bevorzugung, 2 = doppelte Chance'],
    ['weightTier2', 'number', 'Multiplikator Abo Stufe 2'],
    ['weightTier3', 'number', 'Multiplikator Abo Stufe 3'],
    ['weightVip', 'number', 'Multiplikator VIP'],
  ]],
  ['Gewinner-Bestätigung', [
    ['confirmEnabled', 'check', 'Gewinner muss sich im Chat melden'],
    ['confirmSeconds', 'number', 'Zeit zum Melden (Sekunden)'],
    ['autoReroll', 'check', 'Automatisch neu ziehen, wenn keine Meldung'],
  ]],
  ['Chat-Nachrichten', [
    ['chatAnnounceStart', 'check', 'Start ankündigen'],
    ['msgStart', 'textarea', 'Start-Nachricht', 'Platzhalter: {title} {prize} {keyword}'],
    ['chatAnnounceEnd', 'check', 'Ende der Teilnahme ankündigen'],
    ['msgEnd', 'textarea', 'Ende-Nachricht', 'Platzhalter: {count}'],
    ['chatAnnounceWinner', 'check', 'Gewinner ankündigen'],
    ['msgWinner', 'textarea', 'Gewinner-Nachricht', 'Platzhalter: {user} {prize}'],
    ['msgConfirm', 'textarea', 'Gewinner (mit Bestätigung)', 'Platzhalter: {user} {seconds}'],
    ['msgConfirmed', 'textarea', 'Bestätigt-Nachricht'],
    ['msgExpired', 'textarea', 'Nicht gemeldet-Nachricht'],
    ['chatReplyEntered', 'check', 'Teilnahme im Chat bestätigen'],
    ['msgEntered', 'textarea', 'Teilnahme-Nachricht'],
    ['chatReplyRejected', 'check', 'Ablehnung im Chat mitteilen'],
    ['msgRejected', 'textarea', 'Ablehnungs-Nachricht', 'Platzhalter: {user} {reason}'],
  ]],
  ['Overlay', [
    ['overlayAccent', 'color', 'Akzentfarbe'],
    ['overlayTheme', 'select', 'Design', '', [['dark', 'Dunkel'], ['light', 'Hell']]],
    ['overlayShowEntries', 'check', 'Neue Teilnehmer anzeigen'],
    ['overlaySpinSeconds', 'number', 'Dauer der Ziehungs-Animation (Sekunden)'],
  ]],
];

let settingsDirty = false;
function renderSettingsForm() {
  const form = $('#settingsForm');
  form.innerHTML = SCHEMA.map(([group, fields]) => `
    <fieldset><legend>${esc(group)}</legend><div class="grid2">
      ${fields.map(([key, type, label, hint, opts]) => {
        const id = 's_' + key;
        const h = hint ? `<div class="hint">${esc(hint)}</div>` : '';
        if (type === 'check') return `<div><div class="field check"><input type="checkbox" id="${id}" name="${key}"><label for="${id}">${esc(label)}</label></div>${h}</div>`;
        if (type === 'textarea' || type === 'list') return `<div style="grid-column:1/-1"><label for="${id}">${esc(label)}</label><textarea id="${id}" name="${key}"></textarea>${h}</div>`;
        if (type === 'select') return `<div><label for="${id}">${esc(label)}</label><select id="${id}" name="${key}">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>${h}</div>`;
        const step = type === 'number' ? ' step="any" min="0"' : '';
        return `<div><label for="${id}">${esc(label)}</label><input id="${id}" name="${key}" type="${type}"${step}>${h}</div>`;
      }).join('')}
    </div></fieldset>`).join('') + `
    <div class="sticky-save"><button class="primary" type="submit">Einstellungen speichern</button><span class="muted" id="dirtyHint"></span></div>`;
  form.addEventListener('input', () => { settingsDirty = true; $('#dirtyHint').textContent = 'Ungespeicherte Änderungen'; });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = {};
    for (const [, fields] of SCHEMA) for (const [key, type] of fields) {
      const el = form.elements[key];
      out[key] = type === 'check' ? el.checked : type === 'number' ? Number(el.value) : type === 'list' ? el.value : el.value;
    }
    try {
      await api('settings', out);
      settingsDirty = false;
      $('#dirtyHint').textContent = '';
      toast('Gespeichert ✔');
    } catch (e) { toast(e.message, true); }
  });
}
function fillSettings(s) {
  if (settingsDirty) return;
  const form = $('#settingsForm');
  for (const [, fields] of SCHEMA) for (const [key, type] of fields) {
    const el = form.elements[key];
    if (!el) continue;
    if (type === 'check') el.checked = Boolean(s[key]);
    else if (type === 'list') el.value = (s[key] || []).join('\n');
    else el.value = s[key];
  }
}

// ---------- Rendering ----------
const STATUS = {
  idle: ['Bereit', ''],
  open: ['Teilnahme offen', 'ok'],
  closed: ['Teilnahme geschlossen', 'warn'],
  confirming: ['Warte auf Gewinner …', 'warn'],
};

function tags(e) {
  const t = [];
  const i = e.info || {};
  if (i.subTier) t.push(`<span class="tag sub">Abo ${i.subTier}</span>`);
  if (i.vip) t.push('<span class="tag vip">VIP</span>');
  if (i.mod) t.push('<span class="tag">Mod</span>');
  if (i.followDays !== undefined) t.push(`<span class="tag">folgt ${i.followDays} T.</span>`);
  if (e.sim) t.push('<span class="tag sim">Test</span>');
  return t.join('');
}

function render() {
  const s = state;
  const [label, cls] = STATUS[s.status] || [s.status, ''];
  $('#statusText').textContent = label;
  $('#statusDot').className = 'dot ' + cls;
  $('#giveawayTitle').textContent = s.settings.title + (s.settings.prize ? ' – ' + s.settings.prize : '');
  $('#statEntries').textContent = s.entries.length;
  $('#statRejected').textContent = s.rejected.length;
  const won = s.winners.filter((w) => w.status === 'won' || w.status === 'pending').length;
  $('#statWinners').textContent = `${won}/${s.settings.winnerCount}`;

  $('#openBtn').disabled = s.status === 'open' || s.status === 'confirming';
  $('#closeBtn').disabled = s.status !== 'open';
  $('#drawBtn').disabled = !(s.status === 'open' || s.status === 'closed') || s.entries.length === 0;
  $('#openBtn').textContent = s.status === 'closed' ? '▶ Wieder öffnen' : '▶ Teilnahme öffnen';

  // Kopfzeile
  const tw = s.twitch;
  $('#twitchPill').innerHTML = `<span class="dot ${tw.connected ? 'ok' : 'bad'}"></span><span>${tw.connected ? 'Twitch: ' + esc(tw.displayName) : tw.configured ? 'Twitch nicht verbunden' : 'Testmodus (kein Twitch)'}</span>`;
  $('#chatPill').innerHTML = `<span class="dot ${s.chatStatus.startsWith('verbunden') ? 'ok' : 'bad'}"></span><span>Chat: ${esc(s.chatStatus)}</span>`;
  $('#connectBtn').hidden = tw.connected || !tw.configured;

  // Gewinner
  const STAT = { won: 'Gewonnen', pending: 'Wartet auf Meldung', expired: 'Nicht gemeldet', rerolled: 'Verworfen' };
  $('#winners').innerHTML = s.winners.length ? s.winners.map((w) => `
    <div class="winner ${w.status}">
      <span class="name">${esc(w.displayName)}</span>
      <span class="muted">${STAT[w.status]} · ${w.chance} % · ${time(w.drawnAt)}</span>
      ${w.status === 'pending' ? '<button class="small primary" data-confirm>Bestätigen</button>' : ''}
      ${w.status === 'won' || w.status === 'pending' ? `<button class="small" data-reroll="${esc(w.login)}">Neu ziehen</button>` : ''}
      <div class="mono muted" style="width:100%">Wurf ${w.roll} von ${w.total} · Pool ${w.poolSize}</div>
    </div>`).join('') : '<div class="empty">Noch niemand gezogen</div>';

  // Teilnehmer
  const q = $('#entrySearch').value.trim().toLowerCase();
  const list = s.entries.filter((e) => !q || e.login.includes(q)).slice().reverse();
  $('#entryCount').textContent = `${s.entries.length} Teilnehmer`;
  $('#entryRows').innerHTML = list.length ? list.slice(0, 500).map((e) => `
    <tr><td><b>${esc(e.displayName)}</b></td><td>${tags(e)}</td><td>${e.weight}</td><td>${e.chance} %</td>
    <td><button class="small danger" data-remove="${esc(e.login)}" title="Entfernen">✕</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">Noch keine Teilnehmer</td></tr>';

  $('#tab-rejected p').innerHTML = `Wer <b>${esc(s.settings.keyword)}</b> geschrieben hat, aber die Bedingungen nicht erfüllt.`;
  $('#rejectedRows').innerHTML = s.rejected.length ? s.rejected.map((r) => `
    <tr><td class="mono">${time(r.t)}</td><td>${esc(r.displayName)}</td><td>${esc(r.reason)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Keine Ablehnungen</td></tr>';

  $('#log').innerHTML = s.log.slice().reverse().map((l) => `<div><time>${time(l.t)}</time>${esc(l.text)}</div>`).join('') || '<div class="empty">Leer</div>';

  $('#historyRows').innerHTML = s.history.length ? s.history.map((h) => `
    <tr><td>${dateTime(h.date)}</td><td>${esc(h.title)}${h.prize ? ' – ' + esc(h.prize) : ''}</td><td>${h.entries}</td><td>${h.winners.map(esc).join(', ')}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Noch keine abgeschlossenen Verlosungen</td></tr>';

  $('#overlayUrl').value = s.overlayUrl;
  $('#openOverlay').href = s.overlayUrl;

  $('#accountInfo').innerHTML = tw.connected
    ? `<div class="result ok">Verbunden als <b>${esc(tw.displayName)}</b> (${esc(tw.login)})</div>`
    : `<div class="result bad">Nicht mit Twitch verbunden${tw.configured ? '' : ' – TWITCH_CLIENT_ID/SECRET fehlen in der .env'}</div>`;

  fillSettings(s.settings);
  updateTimer();
}

function updateTimer() {
  if (!state) return;
  let txt = '';
  if (state.status === 'open' && state.closesAt) txt = `Schließt in ${Math.max(0, Math.ceil((state.closesAt - Date.now()) / 1000))} s`;
  if (state.status === 'confirming' && state.confirm) txt = `Gewinner hat noch ${Math.max(0, Math.ceil((state.confirm.deadline - Date.now()) / 1000))} s zum Melden`;
  $('#timer').textContent = txt;
}
setInterval(updateTimer, 500);

function renderCheck(el, r, title) {
  el.innerHTML = `
    ${title ? `<p><b>${esc(title)}</b></p>` : ''}
    <div class="result ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✔ Darf teilnehmen' : '✘ Darf nicht teilnehmen'} · Gewicht ${r.weight}</div>
    <ul class="checks">${r.checks.length ? r.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}"><b>${esc(c.name)}:</b> ${esc(c.detail)}</li>`).join('') : '<li class="ok">Keine Bedingungen aktiv</li>'}</ul>`;
}

// ---------- Events ----------
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab));
});

$('#openBtn').onclick = () => act('open');
$('#closeBtn').onclick = () => act('close');
$('#drawBtn').onclick = async () => {
  $('#drawBtn').disabled = true;
  const r = await api('draw', {}).catch((e) => toast(e.message, true));
  if (r && !r.winner) toast('Keine gültigen Teilnehmer mehr übrig', true);
};
$('#resetBtn').onclick = () => confirm('Aktuelle Verlosung verwerfen und neu beginnen?') && act('reset');
$('#winners').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.reroll) act('reroll', { login: b.dataset.reroll });
  if ('confirm' in b.dataset) act('confirm');
});
$('#entryRows').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-remove]');
  if (b) act('remove', { login: b.dataset.remove });
});
$('#entrySearch').addEventListener('input', () => state && render());

$('#copyOverlay').onclick = () => navigator.clipboard.writeText($('#overlayUrl').value).then(() => toast('Kopiert'));
$('#rotateOverlay').onclick = () => confirm('Neuen Overlay-Link erzeugen? Der alte Link in OBS muss dann ersetzt werden.') && act('overlay/rotate');
$('#logoutBtn').onclick = () => fetch('/auth/logout', { method: 'POST' }).then(() => (location.href = '/login'));
$('#disconnectTwitch').onclick = () => confirm('Twitch-Verbindung trennen?') && act('twitch/disconnect');
$('#clearHistory').onclick = () => confirm('Kompletten Verlauf löschen?') && act('history/clear');

$('#checkForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const el = $('#checkResult');
  el.innerHTML = '<p class="muted">Prüfe …</p>';
  try {
    const r = await api('check', { login: $('#checkLogin').value });
    renderCheck(el, r, r.user.displayName);
  } catch (e) { el.innerHTML = `<div class="result bad">${esc(e.message)}</div>`; }
});

function simData() {
  const f = $('#simForm').elements;
  return {
    login: f.login.value, message: f.message.value, subTier: Number(f.subTier.value),
    follows: f.follows.checked, followDays: Number(f.followDays.value), accountAgeDays: Number(f.accountAgeDays.value),
    vip: f.vip.checked, mod: f.mod.checked,
  };
}
$('#simCheck').onclick = async () => {
  try { renderCheck($('#simResult'), await api('sim/check', simData())); } catch (e) { toast(e.message, true); }
};
$('#simForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const d = simData();
  try {
    renderCheck($('#simResult'), await api('sim/check', d), 'Prüfergebnis für ' + d.login);
    const r = await api('sim/chat', d);
    if (r.status !== 'open' && r.status !== 'confirming') toast('Hinweis: Die Teilnahme ist nicht geöffnet', true);
    else toast(`"${d.message}" von ${d.login} gesendet`);
  } catch (e) { toast(e.message, true); }
});
$('#bulkBtn').onclick = () => act('sim/bulk', { count: Number($('#bulkCount').value) }).then((r) => r && toast('Testzuschauer hinzugefügt'));
$('#chatTestBtn').onclick = () => act('chat/test', { message: $('#chatTestMsg').value }).then(() => toast('Gesendet (sofern Chat verbunden)'));
$('#chatReconnect').onclick = () => act('chat/reconnect');

// ---------- Live-Verbindung ----------
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const pill = (ok, txt) => ($('#wsPill').innerHTML = `<span class="dot ${ok ? 'ok' : 'bad'}"></span><span>${txt}</span>`);
  ws.onopen = () => pill(true, 'Live');
  ws.onclose = (ev) => {
    pill(false, 'Getrennt');
    if (ev.code === 4001) return (location.href = '/login');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg.data; render(); }
    if (msg.type === 'drawn') toast(`🏆 Gezogen: ${msg.data.winner.displayName}`);
    if (msg.type === 'expired') toast(`⌛ ${msg.data.displayName} hat sich nicht gemeldet`, true);
    if (msg.type === 'confirmed') toast(`✅ ${msg.data.displayName} hat bestätigt`);
  };
}

renderSettingsForm();
connect();
