'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  tts: { provider: 'system', activeVoice: null },
  google: { connected: false, tokens: null, email: null, name: null },
  github: { connected: false, accessToken: null, username: null, name: null },
  memory: { entries: [] },
};

class Settings {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this._data = this._load();
    console.log('[settings] Loaded from', SETTINGS_FILE);
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return {
        tts: { ...DEFAULTS.tts, ...raw.tts },
        google: { ...DEFAULTS.google, ...raw.google },
        github: { ...DEFAULTS.github, ...raw.github },
        memory: { ...DEFAULTS.memory, ...raw.memory },
      };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  _save() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this._data, null, 2));
  }

  get(key) {
    return this._data[key];
  }

  set(key, value) {
    this._data[key] = { ...this._data[key], ...value };
    this._save();
    console.log(`[settings] Updated '${key}':`, JSON.stringify(value).slice(0, 120));
  }

  getAll() {
    return JSON.parse(JSON.stringify(this._data));
  }
}

let instance = null;
module.exports = {
  getInstance() {
    if (!instance) instance = new Settings();
    return instance;
  },
};
