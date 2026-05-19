'use strict';

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withScheme);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const BrowserTool = {
  name: 'browser',
  description: 'Open public URLs in the user browser. Use when the user asks to open a website, page, or game in a new tab.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open_url'],
        description: 'Browser operation to perform',
      },
      url: {
        type: 'string',
        description: 'Absolute http(s) URL to open',
      },
      label: {
        type: 'string',
        description: 'Short human-readable label for the URL',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining why this requires a browser action',
      },
    },
    required: ['action', 'url', 'reason'],
  },

  async execute({ action, url, label }, ctx = {}) {
    if (action !== 'open_url') return `Unknown browser action: ${action}`;

    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) return `Invalid URL: ${url}`;

    if (ctx.onStatus) {
      ctx.onStatus({
        type: 'client_action',
        action: 'open_url',
        url: normalizedUrl,
        label: label || normalizedUrl,
      });
    }

    return `Open request sent: ${normalizedUrl}`;
  },
};

module.exports = BrowserTool;
