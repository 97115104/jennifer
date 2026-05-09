'use strict';

const axios = require('axios');

function getSettings() {
  return require('../core/Settings').getInstance();
}

const GithubTool = {
  name: 'github',
  description: 'Interact with GitHub: create repositories, list repos, push files, get user info. Requires GitHub to be connected in Settings first.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_user', 'list_repos', 'create_repo', 'push_file'],
        description: 'Action to perform on GitHub',
      },
      name: {
        type: 'string',
        description: 'Repository name (for create_repo)',
      },
      description: {
        type: 'string',
        description: 'Repository description (for create_repo)',
      },
      private: {
        type: 'boolean',
        description: 'Make the repository private (for create_repo)',
      },
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" or just "repo" format (for push_file)',
      },
      file_path: {
        type: 'string',
        description: 'File path within the repository (for push_file)',
      },
      content: {
        type: 'string',
        description: 'File content to push (for push_file)',
      },
      message: {
        type: 'string',
        description: 'Commit message (for push_file)',
      },
    },
    required: ['action'],
  },

  async execute({ action, name, repo_name, description, private: isPrivate, repo, repository, file_path, path: filePath, content, message }) {
    // Accept common model aliases so it resolves on the first try
    name = name || repo_name;
    repo = repo || repository || repo_name;
    file_path = file_path || filePath;
    const settings = getSettings();
    const github = settings.get('github');

    if (!github.connected || !github.accessToken) {
      return 'GitHub is not connected. Please open Settings (/settings) and connect your GitHub account first.';
    }

    const token = github.accessToken;
    const username = github.username;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Jennifer-AI',
    };
    const api = 'https://api.github.com';

    console.log(`[github] action=${action} user=${username}`);

    try {
      if (action === 'get_user') {
        const r = await axios.get(`${api}/user`, { headers });
        return `GitHub user: ${r.data.login}, name: ${r.data.name || 'N/A'}, public repos: ${r.data.public_repos}`;
      }

      if (action === 'list_repos') {
        const r = await axios.get(`${api}/user/repos?sort=updated&per_page=10`, { headers });
        const list = r.data.map(r => `${r.full_name} (${r.private ? 'private' : 'public'})`).join('\n');
        return `Your 10 most recently updated repos:\n${list}`;
      }

      if (action === 'create_repo') {
        if (!name) return 'Repository name is required for create_repo action';
        try {
          const r = await axios.post(`${api}/user/repos`, {
            name,
            description: description || '',
            private: isPrivate || false,
            auto_init: true,
          }, { headers });
          console.log(`[github] Created repo: ${r.data.full_name}`);
          return `Repository created: ${r.data.html_url}`;
        } catch (createErr) {
          // 422 = repo already exists — treat as success so push_file can proceed
          if (createErr.response?.status === 422) {
            console.log(`[github] Repo "${name}" already exists — continuing`);
            return `Repository https://github.com/${username}/${name} already exists — ready to push files.`;
          }
          throw createErr;
        }
      }

      if (action === 'push_file') {
        if (!repo || !file_path || content === undefined) {
          return 'repo, file_path, and content are all required for push_file action';
        }
        const fullRepo = repo.includes('/') ? repo : `${username}/${repo}`;

        // Get existing file SHA if it exists (needed for updates)
        let sha;
        try {
          const existing = await axios.get(`${api}/repos/${fullRepo}/contents/${file_path}`, { headers });
          sha = existing.data.sha;
          console.log(`[github] Updating existing file ${file_path} (sha=${sha.slice(0, 7)})`);
        } catch {
          console.log(`[github] Creating new file ${file_path}`);
        }

        const body = {
          message: message || `Add ${file_path}`,
          content: Buffer.from(content).toString('base64'),
        };
        if (sha) body.sha = sha;

        await axios.put(`${api}/repos/${fullRepo}/contents/${file_path}`, body, { headers });
        return `File pushed: ${file_path} → https://github.com/${fullRepo}`;
      }

      return `Unknown action: ${action}. Valid actions: get_user, list_repos, create_repo, push_file`;
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      console.error(`[github] Error (${action}):`, detail);
      return `GitHub error: ${detail}`;
    }
  },
};

module.exports = GithubTool;
