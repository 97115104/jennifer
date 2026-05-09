'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const HISTORY_DIR = path.join(__dirname, '../../data/history');

function ensure() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

const ConversationHistory = {
  save(messages) {
    const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    if (turns.length === 0) return null;
    ensure();

    const id = uuidv4();
    const firstUser = turns.find(m => m.role === 'user');
    const preview = firstUser ? String(firstUser.content).slice(0, 120) : 'Conversation';

    const entry = {
      id,
      startTime: new Date().toISOString(),
      messageCount: turns.length,
      preview,
      messages: messages.filter(m => m.role !== 'system'),
    };

    fs.writeFileSync(path.join(HISTORY_DIR, `${id}.json`), JSON.stringify(entry, null, 2));
    console.log(`[history] Saved conversation ${id} (${turns.length} turns)`);
    return id;
  },

  list() {
    ensure();
    return fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const e = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8'));
          return { id: e.id, startTime: e.startTime, messageCount: e.messageCount, preview: e.preview };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  },

  get(id) {
    const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
    const fp = path.join(HISTORY_DIR, `${safe}.json`);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  },

  delete(id) {
    const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
    const fp = path.join(HISTORY_DIR, `${safe}.json`);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  },
};

module.exports = ConversationHistory;
