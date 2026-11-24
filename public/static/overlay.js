'use strict';
const key = new URLSearchParams(location.search).get('key');
const card = document.getElementById('card');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null;
let spinning = false;

function applyTheme() {
  if (!state) return;
  document.body.classList.toggle('light', state.theme.mode === 'light');
  document.documentElement.style.setProperty('--accent', state.theme.accent || '#9146ff');
}

function show(html) {
  card.innerHTML = html;
  card.classList.add('show');
}
function hide() { card.classList.remove('show'); }

function secondsLeft(t) { return Math.max(0, Math.ceil((t - Date.now()) / 1000)); }

function render() {
  if (!state || spinning) return;
  applyTheme();
  const s = state;
  const head = `<div class="title">${esc(s.title)}</div>${s.prize ? `<div class="prize">🎁 ${esc(s.prize)}</div>` : ''}`;
  const current = s.winners.filter((w) => w.status !== 'expired').at(-1);

  if (s.status === 'open') {
    show(`${head}
      <div class="cta">Schreibe <span class="kw">${esc(s.keyword)}</span> in den Chat!</div>
      <div class="meta"><span id="count">${s.count}</span> Teilnehmer${s.closesAt ? ` · noch <span id="cd">${secondsLeft(s.closesAt)}</span> s` : ''}</div>
      ${s.theme.showEntries ? `<div class="recent">${s.recent.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}`);
  } else if (s.status === 'confirming' && current) {
    show(`<div class="label">Gewinner</div><div class="winner-name">${esc(current.displayName)}</div>
      <div class="meta">Melde dich im Chat! Noch <span id="cd">${s.confirm ? secondsLeft(s.confirm.deadline) : ''}</span> s</div>`);
  } else if (s.status === 'closed' && current) {
    const all = s.winners.filter((w) => w.status === 'won');
    show(`${head}<div class="label" style="margin-top:16px">${all.length > 1 ? 'Gewinner' : 'Gewinner'}</div>
      ${(all.length ? all : [current]).map((w) => `<div class="winner-name">${esc(w.displayName)}</div>`).join('')}`);
  } else if (s.status === 'closed') {
    show(`${head}<div class="meta">Teilnahme geschlossen · ${s.count} Teilnehmer</div><div class="cta">Gleich wird gezogen …</div>`);
  } else {
    hide();
  }
}

setInterval(() => {
  if (!state || spinning) return;
  const cd = document.getElementById('cd');
  if (!cd) return;
  const t = state.status === 'confirming' ? state.confirm?.deadline : state.closesAt;
  if (t) cd.textContent = secondsLeft(t);
}, 250);

// ---------- Ziehungs-Animation ----------
function spin({ winner, reel }) {
  spinning = true;
  applyTheme();
  const names = reel.length ? reel : [winner.displayName];
  const list = [...names, ...names, winner.displayName].slice(-40);
  const H = 90;
  show(`<div class="title">${esc(state?.title || '')}</div>
    <div class="reelbox"><div class="reel" id="reel">${list.map((n) => `<div>${esc(n)}</div>`).join('')}</div></div>
    <div class="label">wird gezogen …</div>`);
  const el = document.getElementById('reel');
  const dur = Math.max(1, (state?.theme.spinSeconds ?? 5)) * 1000;
  const target = (list.length - 1) * H;
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    el.style.transform = `translateY(${-ease(t) * target}px)`;
    if (t < 1) return requestAnimationFrame(frame);
    confetti();
    setTimeout(() => { spinning = false; render(); }, 1200);
  }
  requestAnimationFrame(frame);
}

// ---------- Konfetti ----------
const canvas = document.getElementById('confetti');
const ctx = canvas.getContext('2d');
let parts = [];
function confetti() {
  canvas.width = innerWidth; canvas.height = innerHeight;
  const colors = [getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#9146ff', '#ffd400', '#00e5ff', '#ff4f9a', '#7CFF6B'];
  for (let i = 0; i < 220; i++) {
    parts.push({
      x: innerWidth / 2, y: innerHeight / 2,
      vx: (Math.random() - .5) * 26, vy: Math.random() * -22 - 4,
      r: Math.random() * 6 + 4, c: colors[i % colors.length], a: Math.random() * 6, life: 0,
    });
  }
  if (parts.length === 220) requestAnimationFrame(tick);
}
function tick() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  parts = parts.filter((p) => p.y < canvas.height + 20 && p.life < 400);
  for (const p of parts) {
    p.life++; p.vy += .5; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.a += .2;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
    ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
  }
  if (parts.length) requestAnimationFrame(tick);
  else ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- Verbindung ----------
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?overlay=' + encodeURIComponent(key || ''));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state = msg.data; render(); }
    if (msg.type === 'drawn') spin(msg.data);
    if (msg.type === 'confirmed') confetti();
  };
  ws.onclose = (ev) => { if (ev.code !== 4003) setTimeout(connect, 2000); };
}
connect();
