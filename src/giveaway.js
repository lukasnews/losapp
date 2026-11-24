'use strict';
// Verlosungslogik: Teilnahme, Prüfungen, gewichtete Ziehung, Gewinner-Bestätigung.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const store = require('./store');

const DEFAULT_SETTINGS = {
  title: 'Verlosung',
  prize: '',
  keyword: '!join',
  leaveKeyword: '!leave',
  entryDurationSec: 0, // 0 = manuell schließen
  maxEntries: 0, // 0 = unbegrenzt
  winnerCount: 1,

  // Bedingungen
  requireFollow: true,
  minFollowDays: 0,
  requireSub: false,
  minSubTier: 1,
  minAccountAgeDays: 0,
  excludeBroadcaster: true,
  excludeMods: false,
  excludeVips: false,
  excludeRecentWinners: 0, // Gewinner der letzten N Verlosungen ausschließen
  blacklist: [],
  recheckOnDraw: true, // Bedingungen beim Ziehen erneut prüfen (z.B. Entfolgt?)

  // Gewichtung (Glückschance-Multiplikatoren)
  weightBase: 1,
  weightTier1: 1,
  weightTier2: 1,
  weightTier3: 1,
  weightVip: 1,

  // Gewinner muss sich im Chat melden
  confirmEnabled: false,
  confirmSeconds: 60,
  autoReroll: true,

  // Chat-Nachrichten ({title} {prize} {keyword} {user} {reason} {seconds} {count})
  chatAnnounceStart: true,
  chatAnnounceEnd: true,
  chatAnnounceWinner: true,
  chatReplyEntered: false,
  chatReplyRejected: true,
  msgStart: '🎉 Verlosung "{title}" gestartet! Preis: {prize} – Schreibe {keyword} zum Mitmachen!',
  msgEnd: '⏹ Teilnahme geschlossen – {count} Teilnehmer. Gleich wird gezogen!',
  msgWinner: '🏆 @{user} hat gewonnen: {prize}!',
  msgConfirm: '🏆 @{user} hat gewonnen! Schreib innerhalb von {seconds} Sekunden in den Chat, um den Gewinn zu bestätigen!',
  msgConfirmed: '✅ @{user} hat den Gewinn bestätigt. Glückwunsch!',
  msgExpired: '⌛ @{user} hat sich nicht gemeldet – es wird neu gezogen.',
  msgEntered: '@{user} du bist dabei!',
  msgRejected: '@{user} du kannst leider nicht teilnehmen: {reason}',

  // Overlay
  overlayTheme: 'dark',
  overlayAccent: '#9146ff',
  overlayShowEntries: true,
  overlaySpinSeconds: 5,
};

const DAY = 86_400_000;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');

class Giveaway extends EventEmitter {
  /** @param {{checker: object}} deps checker liefert die Daten für Prüfungen */
  constructor({ checker }) {
    super();
    this.checker = checker;
    const saved = store.load('giveaway', { settings: {}, history: [] });
    this.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
    this.history = saved.history || [];
    this.reset();
  }

  reset() {
    clearTimeout(this.entryTimer);
    clearTimeout(this.confirmTimer);
    this.status = 'idle'; // idle | open | closed | confirming
    this.entries = new Map(); // login -> entry
    this.pending = new Set(); // logins, deren Prüfung gerade läuft
    this.rejected = []; // letzte Ablehnungen
    this.winners = [];
    this.log = [];
    this.openedAt = null;
    this.closesAt = null;
    this.confirm = null; // { login, deadline }
    this.changed();
  }

  persist() {
    store.save('giveaway', { settings: this.settings, history: this.history.slice(-100) });
  }

  changed() {
    this.emit('state', this.snapshot());
  }

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 300) this.log.shift();
  }

  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[k];
      if (typeof def === 'number') {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) this.settings[k] = n;
      } else if (typeof def === 'boolean') this.settings[k] = Boolean(v);
      else if (Array.isArray(def)) {
        const arr = Array.isArray(v) ? v : String(v).split(/[\s,;]+/);
        this.settings[k] = [...new Set(arr.map(norm).filter(Boolean))];
      } else this.settings[k] = String(v).slice(0, 500);
    }
    this.settings.winnerCount = Math.max(1, Math.floor(this.settings.winnerCount));
    this.settings.minSubTier = Math.min(3, Math.max(1, Math.floor(this.settings.minSubTier)));
    this.persist();
    this.changed();
  }

  fmt(template, vars = {}) {
    const all = {
      title: this.settings.title,
      prize: this.settings.prize || this.settings.title,
      keyword: this.settings.keyword,
      count: this.entries.size,
      seconds: this.settings.confirmSeconds,
      ...vars,
    };
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
  }

  say(flag, template, vars) {
    if (this.settings[flag] !== false) this.emit('say', this.fmt(template, vars));
  }

  // ---------- Ablauf ----------
  open() {
    if (this.status === 'open') return;
    if (this.status !== 'closed') this.reset();
    this.status = 'open';
    this.openedAt = Date.now();
    const d = this.settings.entryDurationSec;
    this.closesAt = d > 0 ? Date.now() + d * 1000 : null;
    if (d > 0) this.entryTimer = setTimeout(() => this.close(), d * 1000);
    this.addLog('Teilnahme geöffnet');
    this.say('chatAnnounceStart', this.settings.msgStart);
    this.changed();
  }

  close() {
    if (this.status !== 'open') return;
    clearTimeout(this.entryTimer);
    this.status = 'closed';
    this.closesAt = null;
    this.addLog(`Teilnahme geschlossen (${this.entries.size} Teilnehmer)`);
    this.say('chatAnnounceEnd', this.settings.msgEnd);
    this.changed();
  }

  // ---------- Prüfungen ----------
  /**
   * Prüft einen Benutzer gegen alle aktiven Bedingungen.
   * @param {{id:string, login:string, displayName?:string, badges?:object, sim?:object}} user
   * @returns {Promise<{ok:boolean, checks:Array<{name:string, ok:boolean, detail:string}>, weight:number, info:object}>}
   */
  async evaluate(user) {
    const s = this.settings;
    const login = norm(user.login);
    const checks = [];
    const info = {};
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    const badges = user.badges || {};
    const isBroadcaster = Boolean(badges.broadcaster) || user.id === this.checker.broadcasterId?.();

    try {
      if (s.blacklist.includes(login)) add('Sperrliste', false, 'steht auf der Sperrliste');
      if (s.excludeBroadcaster && isBroadcaster) add('Streamer', false, 'Streamer ist ausgeschlossen');

      if (s.excludeRecentWinners > 0) {
        const recent = this.history.slice(-s.excludeRecentWinners).flatMap((h) => h.winners.map(norm));
        const hit = recent.includes(login);
        add('Letzte Gewinner', !hit, hit ? `hat in den letzten ${s.excludeRecentWinners} Verlosungen gewonnen` : 'ok');
      }

      if (s.excludeMods) {
        info.mod = Boolean(badges.moderator) || (await this.checker.isMod(user));
        add('Moderator', !info.mod, info.mod ? 'Moderatoren sind ausgeschlossen' : 'kein Mod');
      }

      const needVip = s.excludeVips || s.weightVip !== 1;
      if (needVip) info.vip = Boolean(badges.vip) || (await this.checker.isVip(user));
      if (s.excludeVips) add('VIP', !info.vip, info.vip ? 'VIPs sind ausgeschlossen' : 'kein VIP');

      if (s.requireFollow || s.minFollowDays > 0) {
        const followedAt = await this.checker.getFollow(user);
        info.followedAt = followedAt;
        if (!followedAt) add('Follow', false, 'folgt dem Kanal nicht');
        else {
          const days = (Date.now() - new Date(followedAt).getTime()) / DAY;
          info.followDays = Math.floor(days);
          const ok = days >= s.minFollowDays;
          add('Follow', ok, ok ? `folgt seit ${Math.floor(days)} Tagen` : `folgt erst seit ${Math.floor(days)} Tagen (mind. ${s.minFollowDays})`);
        }
      }

      const needSub = s.requireSub || [s.weightTier1, s.weightTier2, s.weightTier3].some((w) => w !== 1);
      if (needSub) {
        info.subTier = await this.checker.getSubTier(user);
        if (s.requireSub) {
          const ok = info.subTier >= s.minSubTier;
          add('Abo', ok, ok ? `Abo Stufe ${info.subTier}` : info.subTier ? `Abo Stufe ${info.subTier} (mind. Stufe ${s.minSubTier})` : 'kein Abonnent');
        }
      }

      if (s.minAccountAgeDays > 0) {
        const created = await this.checker.getCreatedAt(user);
        const days = created ? Math.floor((Date.now() - new Date(created).getTime()) / DAY) : 0;
        info.accountAgeDays = days;
        const ok = days >= s.minAccountAgeDays;
        add('Konto-Alter', ok, ok ? `Konto ist ${days} Tage alt` : `Konto erst ${days} Tage alt (mind. ${s.minAccountAgeDays})`);
      }
    } catch (err) {
      // Fail closed: wenn Twitch nicht antwortet, keine ungeprüfte Teilnahme
      add('Prüfung', false, 'Prüfung fehlgeschlagen: ' + err.message);
    }

    let weight = s.weightBase;
    if (info.subTier === 1) weight *= s.weightTier1;
    if (info.subTier === 2) weight *= s.weightTier2;
    if (info.subTier === 3) weight *= s.weightTier3;
    if (info.vip) weight *= s.weightVip;

    return { ok: checks.every((c) => c.ok), checks, weight: Math.round(weight * 100) / 100, info };
  }

  // ---------- Teilnahme ----------
  /** Wird für jede Chat-Nachricht aufgerufen. */
  async handleMessage(user, text) {
    const login = norm(user.login);
    const msg = String(text || '').trim();
    const first = msg.split(/\s+/)[0].toLowerCase();

    // Gewinner bestätigt durch beliebige Chat-Nachricht
    if (this.status === 'confirming' && this.confirm?.login === login) {
      this.confirmWinner();
      return;
    }

    if (this.status !== 'open') return;
    if (this.settings.leaveKeyword && first === this.settings.leaveKeyword.toLowerCase()) {
      if (this.entries.delete(login)) {
        this.addLog(`${user.displayName || login} hat die Verlosung verlassen`);
        this.changed();
      }
      return;
    }
    if (first !== this.settings.keyword.toLowerCase()) return;
    await this.enter(user);
  }

  async enter(user) {
    const login = norm(user.login);
    const name = user.displayName || user.login;
    if (this.status !== 'open' || this.entries.has(login) || this.pending.has(login)) return { ok: false, duplicate: true };
    if (this.settings.maxEntries > 0 && this.entries.size >= this.settings.maxEntries) {
      return this.reject(user, 'maximale Teilnehmerzahl erreicht');
    }
    this.pending.add(login);
    try {
      const result = await this.evaluate(user);
      if (this.status !== 'open') return { ok: false };
      if (!result.ok) {
        return this.reject(user, result.checks.filter((c) => !c.ok).map((c) => c.detail).join(', '), result);
      }
      this.entries.set(login, {
        id: user.id,
        login,
        displayName: name,
        weight: result.weight,
        info: result.info,
        sim: user.sim,
        badges: user.badges,
        enteredAt: Date.now(),
      });
      this.addLog(`${name} nimmt teil (Gewicht ${result.weight})`);
      this.say('chatReplyEntered', this.settings.msgEntered, { user: name });
      this.emit('entry', { displayName: name });
      this.changed();
      return { ok: true, ...result };
    } finally {
      this.pending.delete(login);
    }
  }

  reject(user, reason, result) {
    const name = user.displayName || user.login;
    this.rejected.unshift({ t: Date.now(), login: norm(user.login), displayName: name, reason });
    this.rejected.length = Math.min(this.rejected.length, 100);
    this.addLog(`${name} abgelehnt: ${reason}`);
    this.say('chatReplyRejected', this.settings.msgRejected, { user: name, reason });
    this.changed();
    return { ok: false, reason, ...result };
  }

  removeEntry(login) {
    if (this.entries.delete(norm(login))) {
      this.addLog(`${login} manuell entfernt`);
      this.changed();
    }
  }

  // ---------- Ziehung ----------
  /** Gewichtete Zufallsauswahl mit kryptografisch sicherem Zufall. */
  pick(pool) {
    const scaled = pool.map((e) => Math.max(0, Math.round(e.weight * 100)));
    const total = scaled.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let r = crypto.randomInt(total);
    for (let i = 0; i < pool.length; i++) {
      if (r < scaled[i]) return { entry: pool[i], roll: r, total };
      r -= scaled[i];
    }
    return null;
  }

  /** Zieht einen Gewinner. Gibt null zurück, wenn niemand mehr übrig ist. */
  async draw() {
    if (this.status === 'open') this.close();
    if (this.status === 'confirming') return null;
    if (this.status !== 'closed') return null;

    const taken = new Set(this.winners.map((w) => w.login));
    while (true) {
      const pool = [...this.entries.values()].filter((e) => !taken.has(e.login));
      const picked = this.pick(pool);
      if (!picked) {
        this.addLog('Keine (weiteren) gültigen Teilnehmer');
        this.changed();
        return null;
      }
      const { entry } = picked;

      if (this.settings.recheckOnDraw) {
        const again = await this.evaluate({ id: entry.id, login: entry.login, displayName: entry.displayName, badges: entry.badges, sim: entry.sim });
        if (!again.ok) {
          const reason = again.checks.filter((c) => !c.ok).map((c) => c.detail).join(', ');
          this.entries.delete(entry.login);
          this.addLog(`${entry.displayName} beim Ziehen disqualifiziert: ${reason}`);
          this.rejected.unshift({ t: Date.now(), login: entry.login, displayName: entry.displayName, reason: 'beim Ziehen: ' + reason });
          continue;
        }
      }

      const winner = {
        login: entry.login,
        displayName: entry.displayName,
        weight: entry.weight,
        chance: Math.round((entry.weight * 100 * 10000) / picked.total) / 100, // in %
        poolSize: pool.length,
        roll: picked.roll,
        total: picked.total,
        drawnAt: Date.now(),
        status: this.settings.confirmEnabled ? 'pending' : 'won',
      };
      this.winners.push(winner);
      this.addLog(`Gezogen: ${winner.displayName} (Chance ${winner.chance} %, Wurf ${winner.roll}/${winner.total})`);

      // Namen für die Animation im Overlay
      const reel = pool.length ? Array.from({ length: 30 }, () => pool[crypto.randomInt(pool.length)].displayName) : [];
      this.emit('drawn', { winner, reel });

      if (this.settings.confirmEnabled) {
        this.status = 'confirming';
        // Ein paar Sekunden extra, damit die Overlay-Animation durch ist
        const delay = (this.settings.confirmSeconds + this.settings.overlaySpinSeconds) * 1000;
        this.confirm = { login: winner.login, deadline: Date.now() + delay };
        this.confirmTimer = setTimeout(() => this.expireWinner(), delay);
        this.say('chatAnnounceWinner', this.settings.msgConfirm, { user: winner.displayName });
      } else {
        this.say('chatAnnounceWinner', this.settings.msgWinner, { user: winner.displayName });
        this.recordHistoryIfDone();
      }
      this.changed();
      return winner;
    }
  }

  confirmWinner() {
    if (this.status !== 'confirming') return;
    clearTimeout(this.confirmTimer);
    const w = this.winners.find((x) => x.login === this.confirm.login && x.status === 'pending');
    if (w) {
      w.status = 'won';
      w.confirmedAt = Date.now();
      this.addLog(`${w.displayName} hat bestätigt`);
      this.say('chatAnnounceWinner', this.settings.msgConfirmed, { user: w.displayName });
      this.emit('confirmed', w);
    }
    this.confirm = null;
    this.status = 'closed';
    this.recordHistoryIfDone();
    this.changed();
  }

  async expireWinner() {
    if (this.status !== 'confirming') return;
    const w = this.winners.find((x) => x.login === this.confirm.login && x.status === 'pending');
    if (w) {
      w.status = 'expired';
      this.addLog(`${w.displayName} hat sich nicht gemeldet`);
      this.say('chatAnnounceWinner', this.settings.msgExpired, { user: w.displayName });
      this.emit('expired', w);
    }
    this.confirm = null;
    this.status = 'closed';
    this.changed();
    if (this.settings.autoReroll) setTimeout(() => this.draw(), 2500);
  }

  /** Gewinner verwerfen (z.B. per Hand) und neu ziehen */
  async reroll(login) {
    const w = this.winners.find((x) => x.login === norm(login));
    if (!w) return null;
    if (this.status === 'confirming' && this.confirm?.login === w.login) {
      clearTimeout(this.confirmTimer);
      this.confirm = null;
      this.status = 'closed';
    }
    w.status = 'rerolled';
    this.addLog(`${w.displayName} verworfen – neu ziehen`);
    this.changed();
    return this.draw();
  }

  recordHistoryIfDone() {
    const won = this.winners.filter((w) => w.status === 'won');
    if (won.length < this.settings.winnerCount) return;
    const id = this.openedAt;
    const existing = this.history.find((h) => h.id === id);
    const item = {
      id,
      title: this.settings.title,
      prize: this.settings.prize,
      date: Date.now(),
      entries: this.entries.size,
      winners: won.map((w) => w.displayName),
    };
    if (existing) Object.assign(existing, item);
    else this.history.push(item);
    this.persist();
  }

  // ---------- Ausgabe ----------
  snapshot() {
    const entries = [...this.entries.values()];
    const totalWeight = entries.reduce((a, e) => a + e.weight, 0);
    return {
      status: this.status,
      settings: this.settings,
      openedAt: this.openedAt,
      closesAt: this.closesAt,
      confirm: this.confirm,
      entries: entries.map((e) => ({
        login: e.login,
        displayName: e.displayName,
        weight: e.weight,
        chance: totalWeight ? Math.round((e.weight / totalWeight) * 10000) / 100 : 0,
        info: e.info,
        enteredAt: e.enteredAt,
        sim: Boolean(e.sim),
      })),
      rejected: this.rejected.slice(0, 50),
      winners: this.winners,
      log: this.log.slice(-100),
      history: this.history.slice(-30).reverse(),
    };
  }

  /** Reduzierte Daten für das öffentliche Overlay */
  publicSnapshot() {
    const s = this.settings;
    return {
      status: this.status,
      title: s.title,
      prize: s.prize,
      keyword: s.keyword,
      closesAt: this.closesAt,
      confirm: this.confirm ? { deadline: this.confirm.deadline } : null,
      count: this.entries.size,
      recent: [...this.entries.values()].slice(-8).map((e) => e.displayName),
      winners: this.winners.filter((w) => w.status !== 'rerolled').map((w) => ({ displayName: w.displayName, status: w.status })),
      theme: { mode: s.overlayTheme, accent: s.overlayAccent, showEntries: s.overlayShowEntries, spinSeconds: s.overlaySpinSeconds },
    };
  }
}

module.exports = { Giveaway, DEFAULT_SETTINGS };
