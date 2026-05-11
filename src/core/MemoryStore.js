'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./Database');

const TYPES = new Set(['email', 'url', 'text']);

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function cleanAliases(value) {
  if (Array.isArray(value)) return value.map(cleanKey).filter(Boolean).slice(0, 20);
  return String(value || '')
    .split(',')
    .map(cleanKey)
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeEntry(input, existing = {}) {
  const type = TYPES.has(input.type) ? input.type : 'text';
  const key = cleanKey(input.key);
  let value = String(input.value || '').trim();

  if (!key) throw new Error('Memory key is required');
  if (!value) throw new Error('Memory value is required');
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error('Email memory values must be valid email addresses');
  }
  if (type === 'url') value = normalizeUrl(value);

  const now = new Date().toISOString();
  return {
    id: existing.id || uuidv4(),
    type,
    key,
    value,
    aliases: cleanAliases(input.aliases),
    note: String(input.note || '').trim().slice(0, 240),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function rowToEntry(row) {
  return {
    id:        row.id,
    type:      row.type,
    key:       row.key_name,
    value:     row.value,
    aliases:   JSON.parse(row.aliases || '[]'),
    note:      row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readEntries() {
  return getDb()
    .prepare('SELECT * FROM memory ORDER BY key_name')
    .all()
    .map(rowToEntry);
}

function writeEntry(entry) {
  getDb().prepare(`
    INSERT OR REPLACE INTO memory (id, type, key_name, value, aliases, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id, entry.type, entry.key, entry.value,
    JSON.stringify(entry.aliases || []), entry.note || '',
    entry.createdAt, entry.updatedAt
  );
}

function list() {
  return readEntries();
}

function create(input) {
  const entry = normalizeEntry(input);
  const existing = getDb().prepare(
    'SELECT id FROM memory WHERE type = ? AND lower(key_name) = lower(?)'
  ).get(entry.type, entry.key);
  if (existing) throw new Error(`A ${entry.type} memory named "${entry.key}" already exists`);
  writeEntry(entry);
  return entry;
}

function update(id, input) {
  const row = getDb().prepare('SELECT * FROM memory WHERE id = ?').get(id);
  if (!row) throw new Error('Memory entry not found');

  const next = normalizeEntry(input, rowToEntry(row));
  const duplicate = getDb().prepare(
    'SELECT id FROM memory WHERE type = ? AND lower(key_name) = lower(?) AND id != ?'
  ).get(next.type, next.key, id);
  if (duplicate) throw new Error(`A ${next.type} memory named "${next.key}" already exists`);

  writeEntry(next);
  return next;
}

function remove(id) {
  const result = getDb().prepare('DELETE FROM memory WHERE id = ?').run(id);
  if (result.changes === 0) throw new Error('Memory entry not found');
}

function scoreEntry(entry, query, type = 'any') {
  if (type !== 'any' && entry.type !== type) return 0;

  const q = normalizeKey(query);
  if (!q) return type === 'any' || entry.type === type ? 1 : 0;

  const names = [entry.key, ...(entry.aliases || [])].map(normalizeKey);
  if (names.includes(q)) return 100;
  if (names.some(name => name.startsWith(q) || q.startsWith(name))) return 75;
  if (names.some(name => name.includes(q) || q.includes(name))) return 50;

  const haystack = normalizeKey(`${entry.key} ${(entry.aliases || []).join(' ')} ${entry.note || ''} ${entry.value}`);
  return haystack.includes(q) ? 25 : 0;
}

function lookup(query, type = 'any', limit = 5) {
  const normalizedType = TYPES.has(type) ? type : 'any';
  return readEntries()
    .map(entry => ({ entry, score: scoreEntry(entry, query, normalizedType) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key))
    .slice(0, limit)
    .map(match => match.entry);
}

function formatForPrompt(entries) {
  if (!entries.length) return '';
  const lines = entries.map(entry => {
    const aliases = entry.aliases?.length ? ` aliases="${entry.aliases.join(', ')}"` : '';
    const note = entry.note ? ` note="${entry.note}"` : '';
    return `- ${entry.type} "${entry.key}"${aliases}: ${entry.value}${note}`;
  });

  return [
    'Saved memory entries relevant to the current user request:',
    ...lines,
    'Use these saved values directly. Do not ask the user to provide a URL, email address, or variable value that is listed here.',
    'If the user asks for the latest content from a saved blog or website, resolve the saved URL first, then use execute_shell with curl.',
    'If the user asks to email a saved contact, call google with action send_email and the saved email address.',
  ].join('\n');
}

module.exports = {
  list,
  create,
  update,
  remove,
  lookup,
  formatForPrompt,
  normalizeUrl,
};
