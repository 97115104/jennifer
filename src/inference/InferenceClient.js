'use strict';

const axios = require('axios');
const config = require('../config');

class InferenceClient {
  constructor(toolRegistry = null) {
    this.toolRegistry = toolRegistry;
    this.baseUrl = config.apiBaseUrl;
    this.apiKey = config.apiKey;
    this.model = config.apiModel;
  }

  async complete(messages, { onStatus } = {}) {
    const history = [...messages];
    const tools = this.toolRegistry ? this.toolRegistry.getSchemas() : [];
    let round = 0;

    while (true) {
      round++;
      const body = {
        model: this.model,
        messages: history,
        web_search: true,
        temperature: 0.7,
        max_tokens: 2048,
      };
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      console.log(`[inference] → POST /v1/chat/completions (round ${round}, ${history.length} messages, ${tools.length} tools)`);
      const t0 = Date.now();

      let response;
      try {
        response = await axios.post(`${this.baseUrl}/v1/chat/completions`, body, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 45000,
        });
      } catch (err) {
        const status = err.response?.status;
        const detail = err.response?.data?.error?.message || err.response?.data || err.message;
        console.error(`[inference] ✗ HTTP ${status || 'network'} error:`, detail);
        throw new Error(`Inference API error: ${detail}`);
      }

      const elapsed = Date.now() - t0;
      const choice = response.data.choices[0];
      const message = choice.message;
      const finishReason = choice.finish_reason;
      const usage = response.data.usage;
      const worker = response.headers['x-429-worker-name'] || 'unknown';
      const tps = response.headers['x-429-tps'] || '?';

      console.log(`[inference] ← ${elapsed}ms | finish=${finishReason} | tokens=${usage?.total_tokens ?? '?'} | worker=${worker} | tps=${tps}`);

      if (finishReason === 'tool_calls' && message.tool_calls?.length) {
        console.log(`[inference] Tool calls requested: ${message.tool_calls.map(c => c.function.name).join(', ')}`);
        history.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.tool_calls,
        });

        for (const call of message.tool_calls) {
          const name = call.function.name;
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { args = {}; }

          console.log(`[inference] Executing tool: ${name}`, JSON.stringify(args).slice(0, 200));
          if (onStatus) onStatus({ type: 'tool_call', name, args });

          const t1 = Date.now();
          let result;
          try {
            result = await this.toolRegistry.execute(name, args);
          } catch (e) {
            result = `Error executing ${name}: ${e.message}`;
            console.error(`[inference] Tool error (${name}):`, e.message);
          }

          const preview = String(result).slice(0, 200).replace(/\n/g, ' ');
          console.log(`[inference] Tool result (${name}, ${Date.now() - t1}ms): ${preview}`);
          if (onStatus) onStatus({ type: 'tool_result', name, result: String(result).slice(0, 500) });

          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
        continue;
      }

      const text = message.content || '';
      if (message.reasoning) {
        console.log(`[inference] Reasoning (${message.reasoning.length} chars): "${message.reasoning.slice(0, 100)}…"`);
      }
      console.log(`[inference] ✅ Response: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`);
      return text;
    }
  }
}

module.exports = InferenceClient;
