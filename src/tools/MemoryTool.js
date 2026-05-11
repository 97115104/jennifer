'use strict';

const MemoryStore = require('../core/MemoryStore');

const MemoryTool = {
  name: 'memory_lookup',
  description: 'Look up saved user variables such as contact emails, website URLs, blogs, aliases, and reusable text. Use this before google action send_email when the recipient is a name, and before execute_shell with curl when the user names a saved website or blog instead of giving an explicit URL.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The name, alias, contact, site, blog, or variable to find, such as "dakota" or "my blog".',
      },
      type: {
        type: 'string',
        enum: ['any', 'email', 'url', 'text'],
        description: 'Optional memory value type to prefer.',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining why this requires a live tool call rather than answering from training knowledge',
      },
    },
    required: ['query', 'reason'],
  },

  async execute({ query, type = 'any' }) {
    const matches = MemoryStore.lookup(query, type, 5);
    if (!matches.length) {
      return JSON.stringify({
        status: 'not_found',
        query,
        message: `No saved memory found for "${query}".`,
      });
    }

    return JSON.stringify({
      status: 'ok',
      query,
      matches: matches.map(entry => ({
        type: entry.type,
        key: entry.key,
        value: entry.value,
        aliases: entry.aliases || [],
        note: entry.note || '',
      })),
    });
  },
};

module.exports = MemoryTool;
