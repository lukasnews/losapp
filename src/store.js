'use strict';
// Einfache JSON-Persistenz: Einstellungen, Tokens, Verlauf überleben Neustarts.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function load(name, fallback) {
  const file = path.join(DATA_DIR, name + '.json');
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return structuredClone(fallback);
  }
}

const timers = {};
function save(name, data) {
  // Schreibvorgänge bündeln, atomar über Temp-Datei ersetzen
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    const file = path.join(DATA_DIR, name + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }, 200);
}

module.exports = { load, save, DATA_DIR };
