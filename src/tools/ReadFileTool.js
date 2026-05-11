'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ReadFileTool = {
  name: 'read_file',
  description: 'Read the contents of a local file. Use this to read documents, code, config files, notes, or any text file on the local machine.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path or path relative to home directory',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining why this requires a live tool call rather than answering from training knowledge',
      },
    },
    required: ['path', 'reason'],
  },

  async execute({ path: filePath }) {
    const resolved = filePath.startsWith('/')
      ? filePath
      : path.join(os.homedir(), filePath);

    console.log(`[read_file] ${resolved}`);

    if (!fs.existsSync(resolved)) {
      return `File not found: ${resolved}`;
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 1024 * 1024) {
      return `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB) — read a specific section instead`;
    }

    const content = fs.readFileSync(resolved, 'utf8');
    return content.length > 6000 ? content.slice(0, 6000) + '\n\n[file truncated]' : content;
  },
};

module.exports = ReadFileTool;
