'use strict';

// Converts OpenAI-format messages to Gemini format and handles tool calling.
// Gemini doesn't use call IDs, so we generate them and attach _toolName to tool
// result messages so the function name is available during format translation.

class GeminiAdapter {
  constructor({ apiKey, model, maxTokens = 8192 }) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelId = model || 'gemini-1.5-flash';
    this.maxTokens = maxTokens;
  }

  // ── Format translation ──────────────────────────────────────────────────────

  _toGeminiContents(messages) {
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const systemInstruction = systemParts.length ? systemParts.join('\n\n') : undefined;

    const contents = [];
    let pendingFnResponses = [];

    const flushFn = () => {
      if (pendingFnResponses.length) {
        contents.push({ role: 'user', parts: pendingFnResponses });
        pendingFnResponses = [];
      }
    };

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        flushFn();
        contents.push({ role: 'user', parts: [{ text: String(msg.content || '') }] });

      } else if (msg.role === 'assistant') {
        flushFn();
        if (msg.tool_calls?.length) {
          const parts = [];
          if (msg.content) parts.push({ text: msg.content });
          for (const tc of msg.tool_calls) {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
            parts.push({ functionCall: { name: tc.function.name, args } });
          }
          contents.push({ role: 'model', parts });
        } else {
          contents.push({ role: 'model', parts: [{ text: String(msg.content || '') }] });
        }

      } else if (msg.role === 'tool') {
        pendingFnResponses.push({
          functionResponse: {
            name: msg._toolName || 'tool',
            response: { content: String(msg.content) },
          },
        });
      }
    }
    flushFn();

    return { systemInstruction, contents };
  }

  _convertSchemaType(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'STRING' };
    const typeMap = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
    const result = { type: typeMap[schema.type] || 'STRING' };
    if (schema.description) result.description = schema.description;
    if (schema.enum) result.enum = schema.enum;
    if (schema.properties) {
      result.properties = {};
      for (const [k, v] of Object.entries(schema.properties)) result.properties[k] = this._convertSchemaType(v);
    }
    if (schema.items) result.items = this._convertSchemaType(schema.items);
    if (schema.required) result.required = schema.required;
    return result;
  }

  _toGeminiTools(tools) {
    if (!tools.length) return undefined;
    return [{
      functionDeclarations: tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        parameters: this._convertSchemaType(t.function.parameters),
      })),
    }];
  }

  // ── Main loop ───────────────────────────────────────────────────────────────

  async complete(messages, tools = [], { onStatus, executeToolCall } = {}) {
    const history = [...messages];
    let round = 0;

    while (true) {
      round++;
      const { systemInstruction, contents } = this._toGeminiContents(history);
      const geminiTools = this._toGeminiTools(tools);

      const modelConfig = { model: this.modelId };
      if (systemInstruction) modelConfig.systemInstruction = systemInstruction;
      if (geminiTools) {
        modelConfig.tools = geminiTools;
        modelConfig.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      }

      const model = this.genAI.getGenerativeModel(modelConfig);
      console.log(`[gemini] → round ${round}, model=${this.modelId}`);
      const t0 = Date.now();

      let result;
      try {
        result = await model.generateContent({
          contents,
          generationConfig: { maxOutputTokens: this.maxTokens, temperature: 0.7 },
        });
      } catch (err) {
        throw new Error(`Gemini API error: ${err.message}`);
      }

      const candidate = result.response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      console.log(`[gemini] ← ${Date.now() - t0}ms | finish=${candidate?.finishReason}`);

      const fnCalls = parts.filter(p => p.functionCall);
      if (fnCalls.length) {
        history.push({
          role: 'assistant',
          content: parts.find(p => p.text)?.text || null,
          tool_calls: fnCalls.map((p, i) => ({
            id: `gc-${round}-${i}`,
            type: 'function',
            function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) },
          })),
        });

        for (let i = 0; i < fnCalls.length; i++) {
          const fc = fnCalls[i];
          const name = fc.functionCall.name;
          const args = fc.functionCall.args;
          const callId = `gc-${round}-${i}`;

          if (onStatus) onStatus({ type: 'tool_call', name, args });
          let toolResult;
          try { toolResult = await executeToolCall(name, args); } catch (e) { toolResult = `Error: ${e.message}`; }
          if (onStatus) onStatus({ type: 'tool_result', name, result: String(toolResult).slice(0, 500) });

          history.push({ role: 'tool', tool_call_id: callId, _toolName: name, content: String(toolResult) });
        }
        continue;
      }

      return parts.find(p => p.text)?.text || result.response.text?.() || '';
    }
  }

  async generate(messages, { maxTokens = 4096, temperature = 0.85 } = {}) {
    const { systemInstruction, contents } = this._toGeminiContents(messages);
    const modelConfig = { model: this.modelId };
    if (systemInstruction) modelConfig.systemInstruction = systemInstruction;

    const model = this.genAI.getGenerativeModel(modelConfig);
    const t0 = Date.now();

    let result;
    try {
      result = await model.generateContent({
        contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      });
    } catch (err) {
      throw new Error(`Gemini generate error: ${err.message}`);
    }

    const text = result.response.text?.() || result.response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    console.log(`[gemini/gen] ← ${Date.now() - t0}ms`);
    return text;
  }
}

module.exports = GeminiAdapter;
