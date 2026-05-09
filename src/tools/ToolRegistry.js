'use strict';

class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  register(tool) {
    this._tools.set(tool.name, tool);
    console.log(`[tools] Registered: ${tool.name}`);
    return this;
  }

  getSchemas() {
    return Array.from(this._tools.values()).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async execute(name, args) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    console.log(`[tools] ${name}(${JSON.stringify(args).slice(0, 120)})`);
    return tool.execute(args);
  }

  list() {
    return Array.from(this._tools.keys());
  }
}

module.exports = ToolRegistry;
