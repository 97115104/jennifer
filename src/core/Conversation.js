'use strict';

class Conversation {
  constructor(systemPrompt) {
    this.messages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }]
      : [];
  }

  addUser(content) {
    this.messages.push({ role: 'user', content });
    return this;
  }

  addAssistant(content, toolCalls = null) {
    const msg = { role: 'assistant', content };
    if (toolCalls) msg.tool_calls = toolCalls;
    this.messages.push(msg);
    return this;
  }

  addToolResult(toolCallId, result) {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    });
    return this;
  }

  getMessages() {
    return this.messages.map(m => ({ ...m }));
  }

  reset(keepSystem = true) {
    this.messages = keepSystem
      ? this.messages.slice(0, 1).filter(m => m.role === 'system')
      : [];
    return this;
  }
}

module.exports = Conversation;
