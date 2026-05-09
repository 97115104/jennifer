'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./Database');

const ConversationHistory = {
  save(messages) {
    const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    if (turns.length === 0) return null;

    const id = uuidv4();
    const firstUser = turns.find(m => m.role === 'user');
    const preview = firstUser ? String(firstUser.content).slice(0, 120) : 'Conversation';
    const stored = messages.filter(m => m.role !== 'system');

    getDb().prepare(`
      INSERT INTO conversation_history (id, start_time, message_count, preview, messages)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, new Date().toISOString(), turns.length, preview, JSON.stringify(stored));

    console.log(`[history] Saved conversation ${id} (${turns.length} turns)`);
    return id;
  },

  list() {
    return getDb()
      .prepare('SELECT id, start_time, message_count, preview FROM conversation_history ORDER BY start_time DESC')
      .all()
      .map(row => ({
        id:           row.id,
        startTime:    row.start_time,
        messageCount: row.message_count,
        preview:      row.preview,
      }));
  },

  get(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9-]/g, '');
    const row = getDb().prepare('SELECT * FROM conversation_history WHERE id = ?').get(safe);
    if (!row) return null;
    return {
      id:           row.id,
      startTime:    row.start_time,
      messageCount: row.message_count,
      preview:      row.preview,
      messages:     JSON.parse(row.messages || '[]'),
    };
  },

  delete(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9-]/g, '');
    const result = getDb().prepare('DELETE FROM conversation_history WHERE id = ?').run(safe);
    return result.changes > 0;
  },
};

module.exports = ConversationHistory;
