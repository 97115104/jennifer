'use strict';

// Converts the internal OpenAI-format message history to Anthropic format,
// calls the Anthropic messages API, and handles the tool-calling loop.

class AnthropicAdapter {
  constructor({ apiKey, model, maxTokens = 8192 }) {
    const Anthropic = require('@anthropic-ai/sdk');
    this.client = new Anthropic.default({ apiKey });
    this.model = model || 'claude-opus-4-7';
    this.maxTokens = maxTokens;
  }

  // ── Format translation ──────────────────────────────────────────────────────

  _toAnthropicMessages(messages) {
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const system = systemParts.length ? systemParts.join('\n\n') : undefined;

    const converted = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        converted.push({ role: 'user', content: String(msg.content || '') });

      } else if (msg.role === 'assistant') {
        if (msg.tool_calls?.length) {
          const content = [];
          if (msg.content) content.push({ type: 'text', text: msg.content });
          for (const tc of msg.tool_calls) {
            let input;
            try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
          converted.push({ role: 'assistant', content });
        } else {
          converted.push({ role: 'assistant', content: String(msg.content || '') });
        }

      } else if (msg.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: msg.tool_call_id, content: String(msg.content) };
        const last = converted[converted.length - 1];
        if (last?.role === 'user' && Array.isArray(last.content)) {
          last.content.push(block);
        } else {
          converted.push({ role: 'user', content: [block] });
        }
      }
    }
    return { system, messages: converted };
  }

  _toAnthropicTools(tools) {
    return tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
  }

  // ── Main loop ───────────────────────────────────────────────────────────────

  async complete(messages, tools = [], { onStatus, executeToolCall } = {}) {
    const history = [...messages];
    let round = 0;

    while (true) {
      round++;
      const { system, messages: anthropicMsgs } = this._toAnthropicMessages(history);
      const params = {
        model: this.model,
        max_tokens: this.maxTokens,
        messages: anthropicMsgs,
      };
      if (system) params.system = system;
      if (tools.length) params.tools = this._toAnthropicTools(tools);

      console.log(`[anthropic] → round ${round}, model=${this.model}`);
      const t0 = Date.now();

      let response;
      try {
        response = await this.client.messages.create(params);
      } catch (err) {
        throw new Error(`Anthropic API error: ${err.message}`);
      }
      console.log(`[anthropic] ← ${Date.now() - t0}ms | stop=${response.stop_reason}`);

      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        const textContent = response.content.find(c => c.type === 'text')?.text || null;

        history.push({
          role: 'assistant',
          content: textContent,
          tool_calls: toolUses.map(tu => ({
            id: tu.id,
            type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          })),
        });

        for (const tu of toolUses) {
          if (onStatus) onStatus({ type: 'tool_call', name: tu.name, args: tu.input });
          let result;
          try { result = await executeToolCall(tu.name, tu.input); } catch (e) { result = `Error: ${e.message}`; }
          if (onStatus) onStatus({ type: 'tool_result', name: tu.name, result: String(result).slice(0, 500) });
          history.push({ role: 'tool', tool_call_id: tu.id, content: String(result) });
        }
        continue;
      }

      return response.content.find(c => c.type === 'text')?.text || '';
    }
  }

  async generate(messages, { maxTokens = 4096, temperature = 0.85 } = {}) {
    const { system, messages: anthropicMsgs } = this._toAnthropicMessages(messages);
    const params = { model: this.model, max_tokens: maxTokens, temperature, messages: anthropicMsgs };
    if (system) params.system = system;

    const t0 = Date.now();
    let response;
    try { response = await this.client.messages.create(params); }
    catch (err) { throw new Error(`Anthropic generate error: ${err.message}`); }

    const text = response.content.find(c => c.type === 'text')?.text || '';
    console.log(`[anthropic/gen] ← ${Date.now() - t0}ms`);
    return text;
  }
}

module.exports = AnthropicAdapter;
