'use strict';

const axios = require('axios');
const https = require('https');
const config = require('../config');
const MemoryStore = require('../core/MemoryStore');

function htmlToText(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, '')
    .replace(/<(br|p|div|li|h[1-6]|tr|td|blockquote|pre|article|section|header|footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
};

const WebFetchTool = {
  name: 'fetch_url',
  description: 'Fetch and read the text content of any web page, blog post, API endpoint, or URL. Returns the readable text content stripped of HTML.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full URL including protocol (https://...)',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining why this requires a live tool call rather than answering from training knowledge',
      },
    },
    required: ['url', 'reason'],
  },

  async execute({ url }) {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      const [match] = MemoryStore.lookup(url, 'url', 1);
      if (match) {
        console.log(`[fetch_url] Resolved "${url}" to saved URL "${match.key}"`);
        url = match.value;
      } else if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(String(url || '').trim())) {
        url = MemoryStore.normalizeUrl(url);
      }
    }

    console.log(`[fetch_url] GET ${url}`);
    const t0 = Date.now();

    try {
      const response = await axios.get(url, {
        timeout: config.fetchTimeoutMs,
        headers: HEADERS,
        httpsAgent,
        maxRedirects: 5,
        decompress: true,
        responseType: 'text',
        validateStatus: s => s < 500,
      });

      const status = response.status;
      const contentType = response.headers['content-type'] || '';
      console.log(`[fetch_url] ${status} ${contentType} in ${Date.now() - t0}ms`);

      if (status >= 400) {
        return `HTTP ${status} error fetching ${url}`;
      }

      let raw = response.data;

      // JSON response — return formatted
      if (contentType.includes('application/json') || (typeof raw === 'object' && raw !== null)) {
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        return text.length > config.fetchMaxChars ? text.slice(0, config.fetchMaxChars) + '\n\n[content truncated]' : text;
      }

      // HTML — extract readable text
      if (contentType.includes('text/html') || String(raw).trimStart().startsWith('<')) {
        const text = htmlToText(String(raw));
        console.log(`[fetch_url] Extracted ${text.length} chars of text`);
        return text.length > config.fetchMaxChars ? text.slice(0, config.fetchMaxChars) + '\n\n[content truncated]' : text;
      }

      // Plain text / XML / other
      const text = String(raw).replace(/\s+/g, ' ').trim();
      return text.length > config.fetchMaxChars ? text.slice(0, config.fetchMaxChars) + '\n\n[content truncated]' : text;
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status} from ${url}`
        : `Network error fetching ${url}: ${err.message}`;
      console.error(`[fetch_url] Error: ${msg}`);
      return msg;
    }
  },
};

module.exports = WebFetchTool;
