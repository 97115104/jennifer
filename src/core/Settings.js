'use strict';

const path = require('path');
const fs = require('fs');
const { getDb, DATA_DIR } = require('./Database');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  app:       { name: 'Jennifer' },
  tts:       { provider: 'system', activeVoice: null, apiKey429: '', voiceRef429: '', autoSpeak: true },
  google:    { connected: false, tokens: null, email: null, name: null },
  github:    { connected: false, accessToken: null, username: null, name: null },
  inference: {
    provider:       'openai-compatible',
    apiUrl:         '',
    apiKey:         '',
    model:          '',
    anthropicApiKey: '',
    geminiApiKey:   '',
  },
};

class Settings {
  constructor() {
    this._db = getDb();
    this._migrateFromJson();
    this._seedInferenceFromEnv();
    console.log('[settings] Ready (SQLite)');
  }

  _migrateFromJson() {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const row = this._db.prepare('SELECT count(*) as n FROM settings').get();
    if (row.n > 0) return;

    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const insert = this._db.prepare(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
      );
      const insertMemory = this._db.prepare(`
        INSERT OR IGNORE INTO memory (id, type, key_name, value, aliases, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this._db.exec('BEGIN');
      try {
        for (const [key, value] of Object.entries(raw)) {
          if (key === 'memory') {
            for (const entry of (value.entries || [])) {
              try {
                insertMemory.run(
                  entry.id, entry.type, entry.key, entry.value,
                  JSON.stringify(entry.aliases || []), entry.note || '',
                  entry.createdAt || new Date().toISOString(),
                  entry.updatedAt || new Date().toISOString()
                );
              } catch { /* skip duplicate */ }
            }
          } else {
            insert.run(key, JSON.stringify(value));
          }
        }
        this._db.exec('COMMIT');
      } catch (txErr) {
        this._db.exec('ROLLBACK');
        throw txErr;
      }
      console.log('[settings] Migrated from settings.json');
    } catch (err) {
      console.warn('[settings] JSON migration failed:', err.message);
    }
  }

  _seedInferenceFromEnv() {
    const row = this._db.prepare("SELECT value FROM settings WHERE key = 'inference'").get();
    if (row) return;

    // First run: seed inference config from .env (if present)
    try {
      require('dotenv').config();
      const seeded = {
        provider: 'openai-compatible',
        apiUrl:   process.env.API_BASE_URL || 'https://api.429inference.com',
        apiKey:   process.env['429-API-KEY'] || '',
        model:    process.env.API_MODEL || 'gpt-oss',
        anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
        geminiApiKey:    process.env.GEMINI_API_KEY || '',
      };
      this._db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'inference', JSON.stringify(seeded)
      );
      console.log('[settings] Seeded inference config from .env');
    } catch { /* ignore */ }
  }

  get(key) {
    const row = this._db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const def = DEFAULTS[key];
    if (!row) return def ? JSON.parse(JSON.stringify(def)) : null;
    try {
      const stored = JSON.parse(row.value);
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        return { ...def, ...stored };
      }
      return stored;
    } catch {
      return def ? JSON.parse(JSON.stringify(def)) : null;
    }
  }

  set(key, value) {
    const existing = this.get(key) || {};
    const merged = (typeof existing === 'object' && !Array.isArray(existing))
      ? { ...existing, ...value }
      : value;
    this._db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())'
    ).run(key, JSON.stringify(merged));
    console.log(`[settings] Updated '${key}':`, JSON.stringify(value).slice(0, 120));
  }

  getAll() {
    const rows = this._db.prepare('SELECT key, value FROM settings').all();
    const result = JSON.parse(JSON.stringify(DEFAULTS));
    for (const row of rows) {
      try {
        const stored = JSON.parse(row.value);
        const def = result[row.key];
        result[row.key] = (def && typeof def === 'object' && !Array.isArray(def))
          ? { ...def, ...stored }
          : stored;
      } catch { /* skip */ }
    }
    return result;
  }
}

let instance = null;
module.exports = {
  getInstance() {
    if (!instance) instance = new Settings();
    return instance;
  },
};
