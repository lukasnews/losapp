'use strict';
// Twitch-Chat über tmi.js: liest Nachrichten, sendet Ankündigungen.
const { EventEmitter } = require('events');
const tmi = require('tmi.js');
const twitch = require('./twitch');

class Chat extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.status = 'getrennt';
  }

  setStatus(s) {
    this.status = s;
    this.emit('status', s);
  }

  async connect() {
    await this.disconnect();
    if (!twitch.connected()) return;
    const channel = twitch.auth.login;
    this.client = new tmi.Client({
      options: { skipUpdatingEmotesets: true },
      connection: { reconnect: true, secure: true },
      identity: { username: channel, password: async () => 'oauth:' + (await twitch.getToken()) },
      channels: [channel],
    });
    this.client.on('message', (_ch, tags, message, self) => {
      if (self) return;
      this.emit('message', {
        id: tags['user-id'],
        login: tags.username,
        displayName: tags['display-name'] || tags.username,
        badges: tags.badges || {},
      }, message);
    });
    this.client.on('connected', () => this.setStatus('verbunden mit #' + channel));
    this.client.on('disconnected', (r) => this.setStatus('getrennt: ' + r));
    this.client.on('reconnect', () => this.setStatus('verbinde neu …'));
    this.setStatus('verbinde …');
    try {
      await this.client.connect();
    } catch (err) {
      this.setStatus('Fehler: ' + err);
    }
  }

  async disconnect() {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    c.removeAllListeners();
    try { await c.disconnect(); } catch { /* egal */ }
    this.setStatus('getrennt');
  }

  async say(text) {
    if (!this.client || !twitch.auth.login) return;
    try {
      await this.client.say(twitch.auth.login, text.slice(0, 480));
    } catch (err) {
      console.warn('Chat-Nachricht fehlgeschlagen:', err);
    }
  }
}

module.exports = new Chat();
