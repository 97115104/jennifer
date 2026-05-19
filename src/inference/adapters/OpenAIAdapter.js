'use strict';

const axios = require('axios');

const TOOL_FAILURE_MESSAGE = "Tool failed. Tell the user naturally that you couldn't complete this action, and offer an alternative.";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatApiError(err) {
  const data = err.response?.data;
  if (!data) return err.message;
  if (typeof data === 'string') return data;
  if (data.error?.message) return data.error.message;
  if (data.message) return data.message;
  if (data.title || data.detail) {
    return [data.title, data.detail].filter(Boolean).join(': ');
  }
  try { return JSON.stringify(data); } catch { return String(data); }
}

function cleanForVoice(text) {
  if (!text) return text;
  text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text.replace(/^(INTENT|FACTUAL|LIVE|ACTION|PLAN|CHITCHAT|CLARIFY|KNOWLEDGE_SUFFICIENT|EMIT|THINK):\s*\S+[^\n]*\n?/gim, '');
  text = text.replace(/^\s*(execute_shell|google|github|browser|memory_lookup|plan_and_execute|read_file|write_file)\s*\([\s\S]*?\)\s*$/gim, '');
  return text.trim();
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

function parseScalar(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed); } catch {}
    }
    return inner.replace(/\\(['"\\])/g, '$1');
  }
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseArgs(argText) {
  let text = String(argText || '').trim();
  if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1);

  const args = {};
  const pairPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,\n}]+)/g;
  let match;
  while ((match = pairPattern.exec(text))) {
    args[match[1]] = parseScalar(match[2]);
  }
  return args;
}

function normalizeJsonish(text) {
  return String(text || '')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => JSON.stringify(inner.replace(/\\'/g, "'")));
}

function extractTextToolCall(text, tools) {
  const allowed = new Set(tools.map(t => t?.function?.name).filter(Boolean));
  if (!allowed.size || !text) return null;

  for (const name of allowed) {
    const pattern = new RegExp(`${name}\\s*\\(([\\s\\S]*?)\\)`, 'im');
    const match = pattern.exec(text);
    if (match) {
      let args = parseArgs(match[1]);
      const trimmed = match[1].trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try { args = JSON.parse(normalizeJsonish(trimmed)); } catch {}
      }
      if (!args.reason) args.reason = 'The model emitted a tool call for live data or an external action.';
      return { name, args };
    }
  }
  return null;
}

class OpenAIAdapter {
  constructor({ apiUrl, apiKey, model, maxTokens = 8192, timeoutMs = 120000 }) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
  }

  async _postChatCompletion(body) {
    const maxAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await axios.post(`${this.apiUrl}/v1/chat/completions`, body, {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: this.timeoutMs,
        });
      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        const retryAfter = Number(err.response?.data?.retry_after || err.response?.headers?.['retry-after'] || 0);
        if (!RETRYABLE_STATUS.has(status) || attempt === maxAttempts) break;
        const delayMs = Math.min(Math.max(retryAfter * 1000, 1000 * attempt), 5000);
        console.warn(`[openai] retryable API error HTTP ${status}; retrying in ${delayMs}ms (${attempt}/${maxAttempts})`);
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  async complete(messages, tools = [], { onStatus, executeToolCall } = {}) {
    const history = [...messages];
    let round = 0;
    let justExecutedTool = false;
    let lastExecutedToolNames = [];

    while (true) {
      round++;
      const onlyContextLookup = lastExecutedToolNames.length > 0
        && lastExecutedToolNames.every(name => name === 'memory_lookup');
      const toolsForRound = justExecutedTool
        ? (onlyContextLookup ? tools.filter(t => t?.function?.name !== 'memory_lookup') : [])
        : tools;
      const body = {
        model: this.model,
        messages: history,
        temperature: 0.7,
        max_tokens: this.maxTokens,
      };
      if (this._is429Inference()) {
        body.think = true;
      } else if (this._supportsChatTemplateThinking()) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      if (toolsForRound.length > 0) {
        body.tools = toolsForRound;
        body.tool_choice = 'auto';
      }

      console.log(`[openai] → round ${round}, ${history.length} msgs, ${toolsForRound.length} tools`);
      const t0 = Date.now();

      let response;
      try {
        response = await this._postChatCompletion(body);
      } catch (err) {
        const detail = formatApiError(err);
        console.error('[openai] ✗', detail);
        throw new Error(`API error: ${detail}`);
      }

      const choice = response.data.choices[0];
      const message = choice.message;
      const finishReason = choice.finish_reason;
      const usage = response.data.usage;
      console.log(`[openai] ← ${Date.now() - t0}ms | finish=${finishReason} | tokens=${usage?.total_tokens ?? '?'}`);

      if (finishReason === 'tool_calls' && message.tool_calls?.length) {
        history.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          const name = call.function.name;
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
          if (onStatus) onStatus({ type: 'tool_call', name, args });
          let result;
          try { result = await executeToolCall(name, args); } catch (e) { result = `Error: ${e.message}`; }
          result = normalizeToolResult(result);
          if (onStatus) onStatus({ type: 'tool_result', name, result: String(result).slice(0, 500) });
          history.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
          justExecutedTool = true;
          lastExecutedToolNames.push(name);
        }
        continue;
      }

      const textToolCall = extractTextToolCall(message.content, toolsForRound);
      if (textToolCall) {
        const callId = `text-tool-${round}-0`;
        console.warn(`[openai] Parsed textual tool call fallback: ${textToolCall.name}`);
        history.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name: textToolCall.name, arguments: JSON.stringify(textToolCall.args) },
          }],
        });
        if (onStatus) onStatus({ type: 'tool_call', name: textToolCall.name, args: textToolCall.args });
        let result;
        try { result = await executeToolCall(textToolCall.name, textToolCall.args); } catch (e) { result = `Error: ${e.message}`; }
        result = normalizeToolResult(result);
        if (onStatus) onStatus({ type: 'tool_result', name: textToolCall.name, result: String(result).slice(0, 500) });
        history.push({ role: 'tool', tool_call_id: callId, content: String(result) });
        justExecutedTool = true;
        lastExecutedToolNames = [textToolCall.name];
        continue;
      }

      return cleanForVoice(message.content || '');
    }
  }

  _is429Inference() {
    return /429inference\.com/i.test(this.apiUrl || '');
  }

  _supportsChatTemplateThinking() {
    return /qwen/i.test(this.model || '');
  }

  async generate(messages, { maxTokens = 4096, temperature = 0.85 } = {}) {
    const body = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (this._is429Inference()) {
      body.think = false;
    } else if (this._supportsChatTemplateThinking()) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    const t0 = Date.now();
    let response;
    try {
      response = await this._postChatCompletion(body);
    } catch (err) {
      const detail = formatApiError(err);
      throw new Error(`Generate error: ${detail}`);
    }
    const text = response.data.choices[0]?.message?.content || '';
    console.log(`[openai/gen] ← ${Date.now() - t0}ms`);
    return text;
  }
}

module.exports = OpenAIAdapter;
