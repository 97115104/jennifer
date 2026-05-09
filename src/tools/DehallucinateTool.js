'use strict';

/**
 * DehallucinateTool — verify a factual claim before acting on it.
 *
 * The model hallucinates confidently. This tool intercepts claims that can be
 * checked and returns a verification verdict before the claim is used in output
 * or in downstream tool calls.
 *
 * Verification strategies:
 *   url_exists   — fetch the URL and check it doesn't 404
 *   github_repo  — check the repo exists via GitHub API
 *   text         — heuristic: flag suspiciously confident absolute claims
 */

const axios = require('axios');
const Settings = require('../core/Settings');

async function checkUrlExists(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 3,
      validateStatus: () => true,  // don't throw on 4xx/5xx
      headers: { 'User-Agent': 'Jennifer-Verify/1.0' },
    });
    const ok = res.status >= 200 && res.status < 400;
    return {
      verified: ok,
      confidence: ok ? 0.95 : 0.05,
      explanation: ok ? `HTTP ${res.status} — URL exists` : `HTTP ${res.status} — URL not accessible`,
    };
  } catch (err) {
    return { verified: false, confidence: 0.1, explanation: `Fetch error: ${err.message}` };
  }
}

async function checkGithubRepo(repoPath) {
  const settings = Settings.getInstance();
  const github = settings.get('github');
  const token = github?.accessToken;

  const [owner, repo] = repoPath.includes('/') ? repoPath.split('/') : [github?.username, repoPath];
  if (!owner || !repo) return { verified: false, confidence: 0.1, explanation: 'Could not parse repo path' };

  try {
    const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': 'Jennifer-Verify/1.0',
      },
      timeout: 8000,
      validateStatus: () => true,
    });
    const ok = res.status === 200;
    return {
      verified: ok,
      confidence: ok ? 0.99 : 0.05,
      url: ok ? res.data.html_url : null,
      explanation: ok
        ? `Repo ${owner}/${repo} exists (${res.data.visibility})`
        : `Repo ${owner}/${repo} not found (HTTP ${res.status})`,
    };
  } catch (err) {
    return { verified: false, confidence: 0.1, explanation: `GitHub API error: ${err.message}` };
  }
}

function checkTextClaim(claim) {
  const hallucination_signals = [
    /\b(always|never|every|all|none|no one|everyone|guaranteed|certainly|definitely)\b/i,
    /\b(100%|zero percent|impossible|absolute)\b/i,
  ];
  const signals = hallucination_signals.filter(p => p.test(claim));
  if (signals.length > 0) {
    return {
      verified: null,
      confidence: 0.4,
      explanation: `Claim contains ${signals.length} absolutist signal(s) — treat with caution. No URL to verify against.`,
    };
  }
  return {
    verified: null,
    confidence: 0.6,
    explanation: 'No URL to verify against — cannot confirm or deny. Claim has no obvious red flags.',
  };
}

const DehallucinateTool = {
  name: 'dehallucinate',
  description: 'Verify a factual claim before using it. Checks URLs are accessible, confirms GitHub repos exist, and flags suspiciously absolute text claims. Returns JSON: { verified, confidence, explanation }.',
  parameters: {
    type: 'object',
    properties: {
      claim: {
        type: 'string',
        description: 'The claim to verify (e.g. "Repository created at https://github.com/user/repo")',
      },
      check_type: {
        type: 'string',
        enum: ['url_exists', 'github_repo', 'text'],
        description: 'What to check: url_exists (fetch URL), github_repo (check repo via API), text (heuristic on claim)',
      },
      target: {
        type: 'string',
        description: 'URL to fetch (url_exists) or "owner/repo" path (github_repo). Not needed for text.',
      },
    },
    required: ['claim', 'check_type'],
  },

  async execute({ claim, check_type, target }) {
    console.log(`[dehallucinate] check_type=${check_type} target=${target || '(none)'}`);
    let result;

    switch (check_type) {
      case 'url_exists':
        if (!target) return JSON.stringify({ verified: false, confidence: 0, explanation: 'No URL provided for url_exists check' });
        result = await checkUrlExists(target);
        break;
      case 'github_repo':
        if (!target) return JSON.stringify({ verified: false, confidence: 0, explanation: 'No repo path provided for github_repo check' });
        result = await checkGithubRepo(target);
        break;
      case 'text':
        result = checkTextClaim(claim);
        break;
      default:
        result = { verified: null, confidence: 0.5, explanation: 'Unknown check type' };
    }

    console.log(`[dehallucinate] verdict: verified=${result.verified} confidence=${result.confidence} — ${result.explanation}`);
    return JSON.stringify(result);
  },
};

module.exports = DehallucinateTool;
