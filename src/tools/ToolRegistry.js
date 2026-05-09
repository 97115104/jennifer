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
    return this.getSchemasExcluding([]);
  }

  // Returns schemas excluding specified tool names (used by PlannerTool sub-calls)
  getSchemasExcluding(excludeNames = []) {
    return Array.from(this._tools.values())
      .filter(t => !excludeNames.includes(t.name))
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  // ctx is passed to tools that accept a second argument (e.g. PlannerTool for onStatus)
  async execute(name, args, ctx = {}) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    console.log(`[tools] ${name}(${JSON.stringify(args).slice(0, 120)})`);
    return tool.execute(args, ctx);
  }

  list() {
    return Array.from(this._tools.keys());
  }
}

module.exports = ToolRegistry;
