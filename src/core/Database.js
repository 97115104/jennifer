'use strict';

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'jennifer.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const Database = require('better-sqlite3');
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS conversation_history (
      id TEXT PRIMARY KEY,
      start_time TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      preview TEXT DEFAULT '',
      messages TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_type_key ON memory(type, lower(key_name));
  `);

  console.log('[db] Ready:', DB_PATH);
  return _db;
}

module.exports = { getDb, DATA_DIR, DB_PATH };
