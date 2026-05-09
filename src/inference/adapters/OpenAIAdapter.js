'use strict';

const axios = require('axios');

class OpenAIAdapter {
  constructor({ apiUrl, apiKey, model, maxTokens = 8192, timeoutMs = 120000 }) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
  }

  async complete(messages, tools = [], { onStatus, executeToolCall } = {}) {
    const history = [...messages];
    let round = 0;

    while (true) {
      round++;
      const body = {
        model: this.model,
        messages: history,
        temperature: 0.7,
        max_tokens: this.maxTokens,
      };
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      console.log(`[openai] → round ${round}, ${history.length} msgs, ${tools.length} tools`);
      const t0 = Date.now();

      let response;
      try {
        response = await axios.post(`${this.apiUrl}/v1/chat/completions`, body, {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: this.timeoutMs,
        });
      } catch (err) {
        const detail = err.response?.data?.error?.message || err.response?.data || err.message;
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
          if (onStatus) onStatus({ type: 'tool_result', name, result: String(result).slice(0, 500) });
          history.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
        }
        continue;
      }

      return message.content || '';
    }
  }

  async generate(messages, { maxTokens = 4096, temperature = 0.85 } = {}) {
    const body = { model: this.model, messages, temperature, max_tokens: maxTokens };
    const t0 = Date.now();
    let response;
    try {
      response = await axios.post(`${this.apiUrl}/v1/chat/completions`, body, {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        timeout: this.timeoutMs,
      });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      throw new Error(`Generate error: ${detail}`);
    }
    const text = response.data.choices[0]?.message?.content || '';
    console.log(`[openai/gen] ← ${Date.now() - t0}ms`);
    return text;
  }
}

module.exports = OpenAIAdapter;
