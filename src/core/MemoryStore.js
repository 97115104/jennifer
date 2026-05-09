'use strict';

const { v4: uuidv4 } = require('uuid');
const Settings = require('./Settings');

const TYPES = new Set(['email', 'url', 'text']);

function settings() {
  return Settings.getInstance();
}

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

function readEntries() {
  const memory = settings().get('memory') || {};
  return Array.isArray(memory.entries) ? memory.entries : [];
}

function writeEntries(entries) {
  settings().set('memory', { entries });
}

function list() {
  return readEntries();
}

function create(input) {
  const entry = normalizeEntry(input);
  const entries = readEntries();
  const duplicate = entries.find(item => normalizeKey(item.key) === normalizeKey(entry.key) && item.type === entry.type);
  if (duplicate) throw new Error(`A ${entry.type} memory named "${entry.key}" already exists`);
  writeEntries([...entries, entry]);
  return entry;
}

function update(id, input) {
  const entries = readEntries();
  const index = entries.findIndex(item => item.id === id);
  if (index === -1) throw new Error('Memory entry not found');

  const next = normalizeEntry(input, entries[index]);
  const duplicate = entries.find(item =>
    item.id !== id && item.type === next.type && normalizeKey(item.key) === normalizeKey(next.key)
  );
  if (duplicate) throw new Error(`A ${next.type} memory named "${next.key}" already exists`);

  entries[index] = next;
  writeEntries(entries);
  return next;
}

function remove(id) {
  const entries = readEntries();
  const next = entries.filter(item => item.id !== id);
  if (next.length === entries.length) throw new Error('Memory entry not found');
  writeEntries(next);
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
    'If the user asks for the latest content from a saved blog or website, call fetch_url with the saved URL first.',
    'If the user asks to email a saved contact, call send_email with the saved email address.',
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
