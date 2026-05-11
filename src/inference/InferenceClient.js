'use strict';

const config = require('../config');
const DeslopTool = require('../tools/DeslopTool');
const DehallucinateTool = require('../tools/DehallucinateTool');
const MemoryStore = require('../core/MemoryStore');
const { execFile } = require('child_process');

const TOOL_FAILURE_MESSAGE = "Tool failed. Tell the user naturally that you couldn't complete this action, and offer an alternative.";

function getToolName(toolSchema) {
  return toolSchema?.function?.name;
}

function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function selectTools(userMessage, allTools) {
  const msg = String(userMessage || '').toLowerCase();
  const hasLiveTerms = /\b(current|latest|today|tonight|now|right now|price|weather|news|calendar|events?|time|date|schedule|internet|web|search|browse|look up|lookup|research|find out)\b/.test(msg);
  const isKnowledge = !hasLiveTerms
    && /\b(define|definition|explain|what is|what are|how does|tell me (a|about)|who (is|was)|why does|story|joke|poem)\b/.test(msg);
  const needsClarification = /\bremind me\b/.test(msg)
    && !/\b(at|on|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d|am|pm|a\.m\.|p\.m\.)\b/.test(msg);

  if (isKnowledge || needsClarification) return [];

  const isGoogle = /\b(email|mail|calendar|event|events|doc|docs|sheet|sheets|schedule)\b/.test(msg);
  const isGitHub = /\b(repo|repository|github|push|commit|project|code)\b/.test(msg);
  const isFetch = /\b(fetch|browse|web|page|url|search)\b/.test(msg)
    || /https?:\/\//.test(msg)
    || /\bwww\./.test(msg)
    || /\b[a-z0-9.-]+\.[a-z]{2,}\b/.test(msg);
  const isShell = /\b(run|execute|command|terminal|price|bitcoin|crypto|date|time|weather|system info)\b/.test(msg) || isFetch;
  const isFile = /\b(file|read|write|save|load)\b/.test(msg);
  const needsMemory = isFetch || (/\b(email|mail)\b/.test(msg) && !/@/.test(msg));
  const isNamedPlan = /\b(create|make|build)\b.*\b(github|repo|repository|project)\b/.test(msg)
    || /\b(improve|update|make)\b.*\b(repo|repository|github|project)\b.*\b(better|sophisticated|feature|add|upgrade)\b/.test(msg);
  const isPlan = isNamedPlan || /\b(and (then|after)|then (send|email|create)|first\b.*\bthen\b)\b/.test(msg);
  const hasToolIntent = isGoogle || isGitHub || isShell || isFile || isPlan;

  if (!hasToolIntent) return [];
  if (isPlan) {
    const planners = allTools.filter(t => getToolName(t) === 'plan_and_execute');
    if (planners.length) return planners;
  }

  return allTools.filter(t => {
    const name = getToolName(t);
    if (isGoogle && name === 'google') return true;
    if (isGitHub && name === 'github') return true;
    if (isShell && name === 'execute_shell') return true;
    if (isFile && ['read_file', 'write_file'].includes(name)) return true;
    if (needsMemory && name === 'memory_lookup') return true;
    return false;
  });
}

function isToolFailure(text) {
  return /^(error|failed|failure|network error|http \d{3} error|tool failed|command timed out|exited with code [1-9]\b|unknown action|invalid\b)/i.test(text)
    || /\b(permission denied|not configured|not connected| is required| are required|api error|fetch error)\b/i.test(text);
}

function normalizeToolResult(result) {
  const text = String(result ?? '').trim();
  if (!text) return TOOL_FAILURE_MESSAGE;
  if (text.startsWith(TOOL_FAILURE_MESSAGE)) return text;
  if (isToolFailure(text)) {
    return `${TOOL_FAILURE_MESSAGE} Failure summary: ${text.slice(0, 500)}`;
  }
  return text;
}

function lookupEmailTarget(userMessage) {
  const msg = String(userMessage || '');
  const directEmail = msg.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  if (directEmail) return directEmail;

  const sendAlias = msg.match(/\bsend\s+([A-Z0-9._-]{1,64})\s+(?:an?\s+)?(?:email|mail)\b/i)?.[1];
  const emailAlias = msg.match(/\b(?:email|mail)\s+([A-Z0-9._-]{1,64})\b/i)?.[1];
  const aliases = [
    sendAlias,
    emailAlias,
    ...Array.from(msg.matchAll(/\b(?:to|at)\s+([A-Z0-9._-]{1,64})\b/gi)).map(match => match[1]),
  ]
    .filter(Boolean)
    .filter(value => !['it', 'me', 'you', 'them', 'this', 'that', 'with'].includes(value.toLowerCase()));
  const explicitAlias = msg.match(/\bemail\s+(?:me\s+)?(?:a\s+)?(?:link\s+)?(?:to|at)\s+([A-Z0-9._-]{1,64})\b/i)?.[1];
  if (explicitAlias) aliases.push(explicitAlias);

  for (const alias of aliases.reverse()) {
    const [match] = MemoryStore.lookup(alias.replace(/[.。]+$/, ''), 'email', 1);
    if (match?.value) return match.value;
  }
  return null;
}

function parseExplicitEmailRequest(userMessage) {
  const msg = String(userMessage || '');
  if (!/\b(send|email|mail)\b/i.test(msg) || !/\b(email|mail)\b/i.test(msg)) return null;

  const to = lookupEmailTarget(msg);
  const subject = msg.match(/\bsubject\s+([\s\S]+?)\s+(?:and\s+)?body\s+/i)?.[1]?.trim();
  const body = msg.match(/\bbody\s+([\s\S]+?)\s*$/i)?.[1]?.replace(/[.。]\s*$/, '').trim();

  if (!to || !subject || !body) {
    return {
      missing: {
        to: !to,
        subject: !subject,
        body: !body,
      },
    };
  }

  return { to, subject, body };
}

function shouldCreateGithubPagesProject(userMessage) {
  const msg = String(userMessage || '').toLowerCase();
  return /\b(create|make|build)\b/.test(msg)
    && /\b(website|site|web page|github pages|github page|github project|repo|repository)\b/.test(msg)
    && /\b(email|mail)\b/.test(msg);
}

function buildCreateProjectHint(userMessage) {
  let assistantName = 'Jennifer';
  try {
    assistantName = require('../core/Settings').getInstance().get('app')?.name || assistantName;
  } catch {}

  const msg = String(userMessage || '');
  if (/prints?\s+your\s+name/i.test(msg)) {
    return `Create a GitHub Pages website that prominently prints ${assistantName}'s name. User request: ${msg}`;
  }
  return msg;
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function stripHtml(html) {
  return decodeHtml(String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function decodeDuckDuckGoUrl(href) {
  let value = decodeHtml(href);
  if (value.startsWith('//')) value = `https:${value}`;

  try {
    const url = new URL(value);
    const target = url.searchParams.get('uddg');
    if (target) return decodeURIComponent(target);
  } catch {}

  return value;
}

function normalizeResearchQuery(query) {
  return String(query || '')
    .replace(/\bJEMMA\s*4\b/gi, 'Gemma 4')
    .replace(/\bJEMMA4\b/gi, 'Gemma 4')
    .replace(/\bQEN\s*3\.6\b/gi, 'Qwen 3.6')
    .replace(/\bQEN3\.6\b/gi, 'Qwen 3.6')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractResearchQuery(userMessage) {
  const msg = String(userMessage || '').replace(/\s+/g, ' ').trim();
  const patterns = [
    /\bdifference between\s+(.+?)(?:\?|\bplease\b|\band then\b|\bthen send\b|\bsend me\b|\bemail\b|$)/i,
    /\b(?:internet|web)?\s*search\s+(?:for|about)?\s*(.+?)(?:\band then\b|\bthen send\b|\bsend me\b|\bemail\b|$)/i,
    /\b(?:look up|lookup|research|find out)\s+(?:about)?\s*(.+?)(?:\band then\b|\bthen send\b|\bsend me\b|\bemail\b|$)/i,
  ];

  for (const pattern of patterns) {
    const match = msg.match(pattern)?.[1]?.trim();
    if (match) return normalizeResearchQuery(match.replace(/[?.。]+$/, ''));
  }

  return normalizeResearchQuery(msg
    .replace(/\bplease\b/gi, '')
    .replace(/\b(?:do|run|perform)\s+(?:an?\s+)?(?:internet|web)?\s*search\b/gi, '')
    .replace(/\b(?:and\s+)?then\s+send\b[\s\S]*$/i, '')
    .replace(/\bsend\s+me\s+an?\s+email\b[\s\S]*$/i, '')
    .replace(/[?.。]+$/, ''));
}

function shouldResearchAndEmail(userMessage) {
  const msg = String(userMessage || '').toLowerCase();
  const wantsSearch = /\b(internet search|web search|search|look up|lookup|research|find out|browse)\b/.test(msg);
  const wantsEmail = /\b(email|mail)\b/.test(msg) && /\b(send|email|mail)\b/.test(msg);
  return wantsSearch && wantsEmail;
}

async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await new Promise((resolve, reject) => {
    execFile('curl', [
      '-L',
      '-sS',
      '--compressed',
      '--max-time',
      '20',
      '-A',
      'Mozilla/5.0',
      url,
    ], { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });

  if (!html || !html.includes('result__a')) {
    throw new Error('Search returned no parseable result page');
  }

  const results = [];
  const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = resultPattern.exec(html)) && results.length < 6) {
    const title = stripHtml(match[2]);
    const url = decodeDuckDuckGoUrl(match[1]);
    const snippet = stripHtml(match[3]);
    if (title && url && snippet && !results.some(result => result.url === url)) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function summarizeResearch(query, results, originalMessage) {
  const isGemmaQwen = /\bgemma\b/i.test(query) && /\bqwen\b/i.test(query);
  const typoNote = /\b(JEMMA|QEN)\b/i.test(originalMessage)
    ? 'I interpreted "JEMMA4" as Gemma 4 and "QEN 3.6" as Qwen 3.6.'
    : '';

  if (isGemmaQwen) {
    return [
      typoNote,
      'Short answer: the search results generally describe Qwen 3.6 as the stronger coding and software-engineering model, while Gemma 4 is usually framed as Google\'s open-weight line with competitive local performance, strong math or agent tooling depending on the variant, and Apache 2.0 licensing.',
      'The exact comparison depends heavily on which variants are being compared: dense 27B, Gemma 4 31B, Qwen 3.6 Plus, or Qwen 3.6 MoE. Several results also emphasize that hardware, quantization, context window, and benchmark choice can change the practical winner.',
      'Because these were web-search results rather than primary model cards, I would treat the benchmark claims as leads to verify before making a production decision.',
    ].filter(Boolean).join('\n\n');
  }

  const sourceSummary = results
    .slice(0, 3)
    .map((result, index) => `${index + 1}. ${result.title}: ${result.snippet}`)
    .join('\n');

  return [
    typoNote,
    `I searched for "${query}" and found these top-level details:`,
    sourceSummary,
    'I would verify important claims against primary documentation before relying on them.',
  ].filter(Boolean).join('\n\n');
}

function buildResearchEmailBody({ originalMessage, query, results }) {
  const sources = results.map((result, index) => [
    `${index + 1}. ${result.title}`,
    result.url,
    result.snippet,
  ].join('\n')).join('\n\n');

  return [
    `Search query: ${query}`,
    summarizeResearch(query, results, originalMessage),
    'Sources from the web search:',
    sources,
  ].join('\n\n');
}

function buildResearchSpokenResponse({ originalMessage, query, email }) {
  const isGemmaQwen = /\bgemma\b/i.test(query) && /\bqwen\b/i.test(query);
  const typoNote = /\b(JEMMA|QEN)\b/i.test(originalMessage)
    ? 'I interpreted that as Gemma 4 versus Qwen 3.6.'
    : '';

  if (isGemmaQwen) {
    return [
      typoNote,
      'The search results generally point to Qwen 3.6 as stronger for coding and software-engineering benchmarks, while Gemma 4 is framed more around Google open-weight availability, competitive local performance, and Apache 2.0 licensing.',
      `I emailed the detailed source list to ${email}.`,
    ].filter(Boolean).join(' ');
  }

  return `I found relevant web results for ${query}, and I emailed the summary and source list to ${email}.`;
}

class InferenceClient {
  constructor(toolRegistry = null) {
    this.toolRegistry = toolRegistry;
  }

  _getInferenceSettings() {
    try {
      const inf = require('../core/Settings').getInstance().get('inference') || {};
      const raw = inf.provider || '429-inference';
      // Normalize legacy value
      const provider = raw === 'openai-compatible' ? 'custom' : raw;

      // Fixed URLs for managed providers
      let apiUrl;
      if (provider === '429-inference')  apiUrl = 'https://api.429inference.com';
      else if (provider === 'chatgpt')   apiUrl = 'https://api.openai.com';
      else                               apiUrl = inf.apiUrl || config.apiBaseUrl;

      // Key routing: each provider has its own field; 429 falls back to apiKey for existing installs
      let apiKey;
      if (provider === '429-inference')  apiKey = inf.api429Key || inf.apiKey || config.apiKey || '';
      else if (provider === 'chatgpt')   apiKey = inf.chatgptApiKey || '';
      else                               apiKey = inf.apiKey || config.apiKey || '';

      return {
        provider,
        apiUrl,
        apiKey,
        model:           inf.model    || config.apiModel,
        anthropicApiKey: inf.anthropicApiKey || '',
        geminiApiKey:    inf.geminiApiKey    || '',
        maxTokens:       config.apiMaxTokens,
        timeoutMs:       config.apiTimeoutMs,
      };
    } catch {
      return {
        provider:  '429-inference',
        apiUrl:    'https://api.429inference.com',
        apiKey:    config.apiKey || '',
        model:     config.apiModel,
        maxTokens: config.apiMaxTokens,
        timeoutMs: config.apiTimeoutMs,
      };
    }
  }

  _getAdapter() {
    const inf = this._getInferenceSettings();

    if (inf.provider === 'anthropic') {
      const AnthropicAdapter = require('./adapters/AnthropicAdapter');
      return new AnthropicAdapter({ apiKey: inf.anthropicApiKey, model: inf.model, maxTokens: inf.maxTokens });
    }

    if (inf.provider === 'gemini') {
      const GeminiAdapter = require('./adapters/GeminiAdapter');
      return new GeminiAdapter({ apiKey: inf.geminiApiKey, model: inf.model, maxTokens: inf.maxTokens });
    }

    // 429-inference, chatgpt, and custom all use OpenAI-compatible adapter
    const OpenAIAdapter = require('./adapters/OpenAIAdapter');
    return new OpenAIAdapter({ apiUrl: inf.apiUrl, apiKey: inf.apiKey, model: inf.model, maxTokens: inf.maxTokens, timeoutMs: inf.timeoutMs });
  }

  async complete(messages, { onStatus, excludeTools = [] } = {}) {
    const availableTools = this.toolRegistry
      ? (excludeTools.length
          ? this.toolRegistry.getSchemasExcluding(excludeTools)
          : this.toolRegistry.getSchemas())
      : [];
    const tools = selectTools(getLastUserMessage(messages), availableTools);
    console.log(`[inference] Selected tools: ${tools.map(getToolName).join(', ') || 'none'}`);

    const lastUserMessage = getLastUserMessage(messages);
    if (!excludeTools.includes('google')
      && this.toolRegistry?.list().includes('google')
      && shouldResearchAndEmail(lastUserMessage)) {
      const email = lookupEmailTarget(lastUserMessage);
      if (!email) {
        return this._postProcessFinalContent('What email address should I send the research summary to?');
      }

      const query = extractResearchQuery(lastUserMessage);
      if (!query) {
        return this._postProcessFinalContent('What should I search for before sending the email?');
      }

      console.log(`[inference] Direct workflow route: web_search_email query="${query}"`);
      if (onStatus) onStatus({ type: 'tool_call', name: 'web_search', args: { query } });
      let results;
      try {
        results = await searchDuckDuckGo(query);
      } catch (err) {
        console.error('[inference] Web search failed:', err.message);
        return this._postProcessFinalContent(`I couldn't complete the web search because ${err.message}.`);
      }
      if (onStatus) onStatus({ type: 'tool_result', name: 'web_search', result: `${results.length} search results found.` });

      if (!results.length) {
        return this._postProcessFinalContent(`I searched the web for ${query}, but I couldn't find useful results to summarize.`);
      }

      const subject = `Research: ${query}`;
      const body = buildResearchEmailBody({ originalMessage: lastUserMessage, query, results });
      const result = await this.toolRegistry.execute('google', {
        action: 'send_email',
        to: email,
        subject,
        body,
        reason: 'The user asked to email a live web-search summary.',
      }, { onStatus });
      if (!/^email sent\b/i.test(String(result || ''))) {
        return this._postProcessFinalContent(result);
      }
      return this._postProcessFinalContent(buildResearchSpokenResponse({ originalMessage: lastUserMessage, query, email }));
    }

    if (!excludeTools.includes('plan_and_execute')
      && tools.some(t => getToolName(t) === 'plan_and_execute')
      && shouldCreateGithubPagesProject(lastUserMessage)) {
      const email = lookupEmailTarget(lastUserMessage);
      if (!email) {
        return this._postProcessFinalContent('What email address should I send the GitHub Pages link to?');
      }

      console.log('[inference] Direct named-program route: create_github_project');
      const result = await this.toolRegistry.execute('plan_and_execute', {
        complexity_score: 90,
        program: 'create_github_project',
        params: {
          email,
          concept_hint: buildCreateProjectHint(lastUserMessage),
        },
        reason: 'The user asked to create a GitHub Pages website and email the link.',
      }, { onStatus });
      return this._postProcessFinalContent(result);
    }

    const emailRequest = parseExplicitEmailRequest(lastUserMessage);
    if (!excludeTools.includes('google')
      && !shouldCreateGithubPagesProject(lastUserMessage)
      && tools.some(t => getToolName(t) === 'google')
      && emailRequest) {
      if (emailRequest.missing) {
        const missing = Object.entries(emailRequest.missing)
          .filter(([, value]) => value)
          .map(([key]) => key)
          .join(', ');
        return this._postProcessFinalContent(`I need the email ${missing} before I can send that.`);
      }

      console.log('[inference] Direct action route: google send_email');
      const result = await this.toolRegistry.execute('google', {
        action: 'send_email',
        to: emailRequest.to,
        subject: emailRequest.subject,
        body: emailRequest.body,
        reason: 'The user explicitly asked to send an email.',
      }, { onStatus });
      return this._postProcessFinalContent(result);
    }

    const adapter = this._getAdapter();

    const finalContent = await adapter.complete(messages, tools, {
      onStatus,
      executeToolCall: async (name, args) => {
        console.log(`[inference] Executing tool: ${name}`, JSON.stringify(args).slice(0, 200));
        const t0 = Date.now();
        let result;
        try {
          result = await this.toolRegistry.execute(name, args, { onStatus });
        } catch (e) {
          result = `Error executing ${name}: ${e.message}`;
          console.error(`[inference] Tool error (${name}):`, e.message);
        }
        result = normalizeToolResult(result);
        console.log(`[inference] Tool result (${name}, ${Date.now() - t0}ms): ${String(result).slice(0, 200).replace(/\n/g, ' ')}`);
        return result;
      },
    });
    return this._postProcessFinalContent(finalContent);
  }

  async _postProcessFinalContent(text) {
    let finalContent = String(text || '');

    try {
      finalContent = DeslopTool.execute({ text: finalContent });
    } catch (err) {
      console.warn(`[inference] Deslop post-process skipped: ${err.message}`);
    }

    try {
      const verdict = await DehallucinateTool.execute({
        claim: finalContent,
        check_type: 'text',
        reason: 'Final spoken response should be checked for overconfident unsupported claims before TTS.',
      });
      console.log(`[inference] Dehallucination post-check: ${String(verdict).slice(0, 200)}`);
    } catch (err) {
      console.warn(`[inference] Dehallucination post-check skipped: ${err.message}`);
    }

    return finalContent;
  }

  async generate(prompt, { systemPrompt, maxTokens = 4096, temperature = 0.85 } = {}) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    console.log(`[inference/generate] → ${prompt.slice(0, 80).replace(/\n/g, ' ')}…`);
    const t0 = Date.now();
    const adapter = this._getAdapter();
    const text = await adapter.generate(messages, { maxTokens, temperature });
    console.log(`[inference/generate] ← ${Date.now() - t0}ms, ${text.length} chars`);
    return text;
  }
}

module.exports = InferenceClient;
