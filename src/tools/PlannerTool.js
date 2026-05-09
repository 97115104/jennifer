'use strict';

// Injected after InferenceClient is created in index.js — avoids circular dep
let _client = null;

// System prompt for each sub-step execution.
// Intentionally terse + directive — the sub-model must use tools, not hedge.
function buildStepPrompt(tools) {
  const toolList = tools.length
    ? `Available tools: ${tools.join(', ')}.`
    : '';
  return `You are executing one step of a multi-step plan.
${toolList}
RULES:
- Use the appropriate tool immediately — do not explain or hedge
- NEVER say "I cannot" or "I don't have the ability" — your tools are real and work
- Complete ONLY this step and report the result concisely (1-2 sentences)
- If this step requires information from the result (e.g. a URL, repo name), include it in your response`;
}

const PlannerTool = {
  name: 'plan_and_execute',
  description: `Break a complex request into ordered steps and execute them one by one.

WHEN TO USE — call this tool FIRST when a request:
  - Requires 3 or more tool calls (e.g. create repo + push file + send email)
  - Has dependent steps (step B needs output from step A)
  - Scores ≥ 60 on the complexity scale

COMPLEXITY SCORING:
  1–40   Simple    — one tool call or direct answer
  41–65  Moderate  — 2 tools, no dependencies
  66–100 Complex   — 3+ tools, dependencies, or multi-file work → use this tool

EXAMPLES that require plan_and_execute:
  "create a GitHub project with code and email me when done" → complexity 90
  "build a web page, push to GitHub, and update the README"  → complexity 85
  "research X, write a report, and save it"                  → complexity 70`,

  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'The original user request, verbatim',
      },
      complexity_score: {
        type: 'number',
        description: 'Complexity 1–100. Must be ≥66 to justify using this tool.',
      },
      reasoning: {
        type: 'string',
        description: 'Why this score — which tools are needed, what depends on what',
      },
      tasks: {
        type: 'array',
        description: 'Ordered steps. Each step maps to exactly one tool call.',
        items: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'Concrete action to perform — include specific values (repo name, email address, etc.)',
            },
            tool_hint: {
              type: 'string',
              description: 'Tool to use: github | send_email | fetch_url | execute_shell | write_file | read_file | memory_lookup',
            },
          },
          required: ['description'],
        },
      },
    },
    required: ['request', 'complexity_score', 'tasks'],
  },

  // Called once from index.js after InferenceClient exists
  inject(inferenceClient) {
    _client = inferenceClient;
    console.log('[planner] InferenceClient injected');
  },

  async execute({ request, complexity_score, reasoning, tasks }, ctx = {}) {
    if (!_client) return 'PlannerTool error: inference client not injected — call PlannerTool.inject() in index.js';
    if (!Array.isArray(tasks) || tasks.length === 0) return 'PlannerTool error: tasks array is empty';

    const onStatus = ctx.onStatus || (() => {});
    const n = tasks.length;

    console.log(`[planner] ▶ Plan started — complexity=${complexity_score}, steps=${n}`);
    if (reasoning) console.log(`[planner] Reasoning: ${reasoning}`);

    // Announce the full plan to the UI
    onStatus({
      type: 'plan_start',
      complexity: complexity_score,
      total: n,
      tasks: tasks.map(t => (typeof t === 'string' ? t : t.description)),
    });

    // Build the tool name list for the step system prompt (excludes plan_and_execute)
    const availableToolNames = _client.toolRegistry
      ? _client.toolRegistry.list().filter(n => n !== 'plan_and_execute')
      : [];

    const completedSummaries = [];

    for (let i = 0; i < n; i++) {
      const task = tasks[i];
      const desc = typeof task === 'string' ? task : task.description;
      const toolHint = typeof task === 'object' ? task.tool_hint : null;

      console.log(`[planner] Step ${i + 1}/${n}: ${desc}${toolHint ? ` [hint: ${toolHint}]` : ''}`);
      onStatus({ type: 'plan_step', step: i + 1, total: n, task: desc, tool_hint: toolHint });

      // Carry forward context from completed steps
      const prevContext = completedSummaries.length > 0
        ? `Results from previous steps:\n${completedSummaries
            .map((s, j) => `  Step ${j + 1} (${(tasks[j].description || tasks[j]).slice(0, 60)}): ${s}`)
            .join('\n')}\n\n`
        : '';

      const messages = [
        { role: 'system', content: buildStepPrompt(availableToolNames) },
        { role: 'user', content: `${prevContext}Execute step ${i + 1}/${n}: ${desc}` },
      ];

      let result;
      try {
        result = await _client.complete(messages, {
          onStatus,
          excludeTools: ['plan_and_execute'],  // prevent recursion
        });
      } catch (err) {
        result = `Step failed: ${err.message}`;
        console.error(`[planner] Step ${i + 1} error:`, err.message);
      }

      const summary = String(result).replace(/\n+/g, ' ').slice(0, 400);
      completedSummaries.push(summary);

      console.log(`[planner] ✓ Step ${i + 1} complete: ${summary.slice(0, 120)}`);
      onStatus({ type: 'plan_step_done', step: i + 1, total: n, task: desc, result: summary });
    }

    onStatus({ type: 'plan_complete', total: n });
    console.log('[planner] ✅ All steps complete');

    // Return a full summary for the outer model to narrate as a natural response
    const summaryLines = tasks
      .map((t, i) => {
        const desc = typeof t === 'string' ? t : t.description;
        return `Step ${i + 1} — ${desc}: ${completedSummaries[i]}`;
      })
      .join('\n');

    return `All ${n} steps completed successfully:\n${summaryLines}`;
  },
};

module.exports = PlannerTool;
