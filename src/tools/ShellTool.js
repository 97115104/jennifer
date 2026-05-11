'use strict';

const { spawn } = require('child_process');
const os = require('os');

const ShellTool = {
  name: 'execute_shell',
  description: 'Execute a shell command. Use for creating files, running git, Jekyll, npm, or any system task. Commands run in the user home directory by default.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to run',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to home directory)',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining why this requires a live tool call rather than answering from training knowledge',
      },
    },
    required: ['command', 'reason'],
  },

  async execute({ command, cwd }) {
    const workDir = cwd || os.homedir();
    return new Promise((resolve) => {
      console.log(`[shell] $ ${command}`);
      const proc = spawn('bash', ['-c', command], {
        cwd: workDir,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolve('Command timed out after 30 seconds.');
      }, 30000);

      proc.on('close', code => {
        clearTimeout(timer);
        const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, 3000);
        resolve(out || `Exited with code ${code}`);
      });
    });
  },
};

module.exports = ShellTool;
