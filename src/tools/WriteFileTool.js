'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const WriteFileTool = {
  name: 'write_file',
  description: 'Write content to a local file. Creates parent directories if needed. Use this to create documents, scripts, config files, or any text file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path or path relative to home directory',
      },
      content: {
        type: 'string',
        description: 'Text content to write to the file',
      },
    },
    required: ['path', 'content'],
  },

  async execute({ path: filePath, content }) {
    const resolved = filePath.startsWith('/')
      ? filePath
      : path.join(os.homedir(), filePath);

    console.log(`[write_file] ${resolved} (${content.length} chars)`);

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');

    return `Written ${content.length} characters to ${resolved}`;
  },
};

module.exports = WriteFileTool;
