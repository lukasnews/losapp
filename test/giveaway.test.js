'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'losapp-test-'));

const test = require('node:test');
const assert = require('node:assert');
const { Giveaway } = require('../src/giveaway');
const checker = require('../src/checker');

const user = (login, sim = {}) => ({ id: 'sim-' + login, login, displayName: login, badges: {}, sim: { follows: true, followDays: 30, subTier: 0, accountAgeDays: 365, ...sim } });

function make(settings = {}) {
  const g = new Giveaway({ checker });
  g.history = [];
  g.updateSettings({ chatAnnounceStart: false, confirmEnabled: false, recheckOnDraw: true, requireFollow: true, ...settings });
  return g;
}

test('nur Follower dürfen teilnehmen', async () => {
  const g = make();
  g.open();
  await g.handleMessage(user('anna'), '!join');
  await g.handleMessage(user('bob', { follows: false }), '!join');
  assert.deepStrictEqual([...g.entries.keys()], ['anna']);
  assert.match(g.rejected[0].reason, /folgt dem Kanal nicht/);
});

test('Mindest-Follow-Dauer, Konto-Alter, Abo-Pflicht, Sperrliste', async () => {
  const g = make({ minFollowDays: 10, minAccountAgeDays: 100, requireSub: true, minSubTier: 2, blacklist: 'Böse, troll' });
  g.open();
  await g.handleMessage(user('neu', { followDays: 2, subTier: 3 }), '!join');
  await g.handleMessage(user('jung', { accountAgeDays: 5, subTier: 3 }), '!join');
  await g.handleMessage(user('t1', { subTier: 1 }), '!join');
  await g.handleMessage(user('troll', { subTier: 3 }), '!join');
  await g.handleMessage(user('ok', { subTier: 2 }), '!join');
  assert.deepStrictEqual([...g.entries.keys()], ['ok']);
  assert.strictEqual(g.rejected.length, 4);
});

test('Mods/VIPs ausschließen, Doppelteilnahme & falsches Schlüsselwort ignoriert', async () => {
  const g = make({ excludeMods: true, excludeVips: true });
  g.open();
  await g.handleMessage(user('mod', { mod: true }), '!join');
  await g.handleMessage(user('vip', { vip: true }), '!join');
  await g.handleMessage(user('x'), '!join');
  await g.handleMessage(user('x'), '!join');
  await g.handleMessage(user('y'), 'hallo !join');
  assert.deepStrictEqual([...g.entries.keys()], ['x']);
});

test('!leave entfernt Teilnehmer, geschlossene Verlosung nimmt niemanden an', async () => {
  const g = make();
  g.open();
  await g.handleMessage(user('a'), '!join');
  await g.handleMessage(user('a'), '!leave');
  g.close();
  await g.handleMessage(user('b'), '!join');
  assert.strictEqual(g.entries.size, 0);
});

test('Gewichtung: Abo Stufe 3 mit Faktor 3', async () => {
  const g = make({ weightTier3: 3 });
  g.open();
  await g.handleMessage(user('sub', { subTier: 3 }), '!join');
  await g.handleMessage(user('nosub'), '!join');
  assert.strictEqual(g.entries.get('sub').weight, 3);
  assert.strictEqual(g.entries.get('nosub').weight, 1);
  const snap = g.snapshot();
  assert.strictEqual(snap.entries.find((e) => e.login === 'sub').chance, 75);
});

test('Ziehung ist gewichtet (statistisch)', () => {
  const g = make();
  const pool = [{ login: 'a', weight: 1 }, { login: 'b', weight: 3 }];
  let b = 0;
  for (let i = 0; i < 20000; i++) if (g.pick(pool).entry.login === 'b') b++;
  assert.ok(Math.abs(b / 20000 - 0.75) < 0.02, 'Anteil b: ' + b / 20000);
});

test('mehrere Gewinner ohne Doppelte, Verlauf + Ausschluss letzter Gewinner', async () => {
  const g = make({ winnerCount: 3, excludeRecentWinners: 1 });
  g.open();
  for (const n of ['a', 'b', 'c', 'd']) await g.handleMessage(user(n), '!join');
  const w = [await g.draw(), await g.draw(), await g.draw()].map((x) => x.login);
  assert.strictEqual(new Set(w).size, 3);
  assert.strictEqual(g.history.length, 1);
  g.reset();
  g.open();
  await g.handleMessage(user(w[0]), '!join');
  assert.strictEqual(g.entries.size, 0);
  assert.match(g.rejected[0].reason, /gewonnen/);
});

test('Erneute Prüfung beim Ziehen disqualifiziert Entfolgte', async () => {
  const g = make();
  g.open();
  const u = user('weg');
  await g.handleMessage(u, '!join');
  await g.handleMessage(user('bleibt'), '!join');
  g.entries.get('weg').sim.follows = false; // entfolgt zwischendurch
  const w = await g.draw();
  assert.strictEqual(w.login, 'bleibt');
  assert.ok(!g.entries.has('weg'));
});

test('Gewinner-Bestätigung über Chat-Nachricht', async () => {
  const g = make({ confirmEnabled: true, confirmSeconds: 30 });
  g.open();
  await g.handleMessage(user('a'), '!join');
  const w = await g.draw();
  assert.strictEqual(g.status, 'confirming');
  await g.handleMessage(user('a'), 'hier!');
  assert.strictEqual(w.status, 'won');
  assert.strictEqual(g.status, 'closed');
});

test('Nicht gemeldet -> verfällt, neu ziehen', async () => {
  const g = make({ confirmEnabled: true, autoReroll: false });
  g.open();
  await g.handleMessage(user('a'), '!join');
  await g.handleMessage(user('b'), '!join');
  const w1 = await g.draw();
  await g.expireWinner();
  assert.strictEqual(w1.status, 'expired');
  const w2 = await g.draw();
  assert.notStrictEqual(w2.login, w1.login);
  clearTimeout(g.confirmTimer);
});

test('Max. Teilnehmer', async () => {
  const g = make({ maxEntries: 2 });
  g.open();
  for (const n of ['a', 'b', 'c']) await g.handleMessage(user(n), '!join');
  assert.strictEqual(g.entries.size, 2);
});
