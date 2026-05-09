'use strict';

const config = require('../config');

class InferenceClient {
  constructor(toolRegistry = null) {
    this.toolRegistry = toolRegistry;
  }

  _getInferenceSettings() {
    try {
      const inf = require('../core/Settings').getInstance().get('inference') || {};
      return {
        provider:        inf.provider || 'openai-compatible',
        apiUrl:          inf.apiUrl   || config.apiBaseUrl,
        apiKey:          inf.apiKey   || config.apiKey || '',
        model:           inf.model    || config.apiModel,
        anthropicApiKey: inf.anthropicApiKey || '',
        geminiApiKey:    inf.geminiApiKey    || '',
        maxTokens:       config.apiMaxTokens,
        timeoutMs:       config.apiTimeoutMs,
      };
    } catch {
      return {
        provider:  'openai-compatible',
        apiUrl:    config.apiBaseUrl,
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

    const OpenAIAdapter = require('./adapters/OpenAIAdapter');
    return new OpenAIAdapter({ apiUrl: inf.apiUrl, apiKey: inf.apiKey, model: inf.model, maxTokens: inf.maxTokens, timeoutMs: inf.timeoutMs });
  }

  async complete(messages, { onStatus, excludeTools = [] } = {}) {
    const tools = this.toolRegistry
      ? (excludeTools.length
          ? this.toolRegistry.getSchemasExcluding(excludeTools)
          : this.toolRegistry.getSchemas())
      : [];

    const adapter = this._getAdapter();

    return adapter.complete(messages, tools, {
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
        console.log(`[inference] Tool result (${name}, ${Date.now() - t0}ms): ${String(result).slice(0, 200).replace(/\n/g, ' ')}`);
        return result;
      },
    });
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
