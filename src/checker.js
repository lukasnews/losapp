'use strict';
// Liefert Prüfdaten: echte Twitch-Abfragen oder – für Testnutzer – simulierte Werte.
const twitch = require('./twitch');

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

module.exports = {
  broadcasterId: () => twitch.auth.userId,

  async getFollow(user) {
    if (user.sim) return user.sim.follows ? ago(user.sim.followDays ?? 30) : null;
    return twitch.getFollow(user.id);
  },
  async getSubTier(user) {
    if (user.sim) return Number(user.sim.subTier) || 0;
    return twitch.getSubTier(user.id);
  },
  async isVip(user) {
    if (user.sim) return Boolean(user.sim.vip);
    return twitch.isVip(user.id);
  },
  async isMod(user) {
    if (user.sim) return Boolean(user.sim.mod);
    return twitch.isMod(user.id);
  },
  async getCreatedAt(user) {
    if (user.sim) return ago(user.sim.accountAgeDays ?? 365);
    return twitch.getCreatedAt(user.id);
  },
};
