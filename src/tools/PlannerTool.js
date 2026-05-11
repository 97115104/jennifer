'use strict';

/**
 * PlannerTool — routes complex requests to deterministic programs.
 *
 * Design principle: the model identifies WHAT the user wants and extracts
 * parameters. The program decides HOW to execute it — sequencing, validation,
 * retries, and tool calls are all deterministic code, not model decisions.
 *
 * Named programs are fully hard-coded pipelines. For requests that don't match,
 * "custom" falls back to sequential step execution with the model handling each
 * individual step (but not the overall sequencing).
 */

let _client = null;
let _tools = {};   // { github, google, ... }

// ─── Named program catalog ───────────────────────────────────────────────────

const PROGRAMS = {
  create_github_project: {
    description: 'Create a brand-new GitHub repo with a creative static page. Use ONLY for new projects — not when the user wants to update something that already exists.',
    requiredParams: ['email'],
    optionalParams: ['concept_hint'],
    example: '{ "email": "user@example.com", "concept_hint": "space exploration theme" }',
  },
  update_github_project: {
    description: 'Improve or update an existing GitHub repo. Use when the user says "make it better", "update X", "improve X", "make it more sophisticated", or references a repo that already exists.',
    requiredParams: ['repo'],
    optionalParams: ['improvement_hint', 'email'],
    example: '{ "repo": "pixel-painter", "improvement_hint": "add undo/redo and color picker", "email": "user@example.com" }',
  },
};

const PROGRAM_LIST = Object.entries(PROGRAMS)
  .map(([k, v]) => `  ${k}: ${v.description}\n    params: ${v.example}`)
  .join('\n');

// ─── Tool definition ──────────────────────────────────────────────────────────

const PlannerTool = {
  name: 'plan_and_execute',

  description: `Execute complex multi-step tasks deterministically.

WHEN TO USE: requests with complexity ≥ 66 (3+ tool calls, or step B needs output from step A).
COMPLEXITY: 1–40 simple (direct answer/1 tool), 41–65 moderate (2 tools), 66+ complex → use this.

NAMED PROGRAMS — prefer these when the request matches:
${PROGRAM_LIST}

CUSTOM — use when no named program fits:
  Set program="custom" and provide a tasks array.`,

  parameters: {
    type: 'object',
    properties: {
      complexity_score: {
        type: 'number',
        description: 'Complexity 1–100. Must be ≥66 to justify this tool.',
      },
      reasoning: {
        type: 'string',
        description: 'One sentence: why this score, which tools are needed',
      },
      program: {
        type: 'string',
        enum: ['create_github_project', 'update_github_project', 'custom'],
        description: 'Named program to run, or "custom" for a bespoke task list',
      },
      params: {
        type: 'object',
        description: 'Parameters for the named program (see descriptions above)',
      },
      tasks: {
        type: 'array',
        description: 'For program="custom" only: ordered list of task steps',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What to do in this step — be specific' },
            tool_hint:   { type: 'string', description: 'Tool to use: github | google | execute_shell | write_file | memory_lookup' },
          },
          required: ['description'],
        },
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining why this requires a live tool call rather than answering from training knowledge',
      },
    },
    required: ['complexity_score', 'program', 'reason'],
  },

  // Called from index.js after everything is wired up
  inject(inferenceClient, toolMap) {
    _client = inferenceClient;
    _tools = toolMap || {};
    console.log('[planner] Injected — programs:', Object.keys(PROGRAMS).join(', '), '| tools:', Object.keys(_tools).join(', '));
    // _tools.google handles email, calendar, docs, sheets
  },

  async execute({ complexity_score, reasoning, program, params = {}, tasks = [] }, ctx = {}) {
    if (!_client) return 'PlannerTool not initialized — call PlannerTool.inject() in index.js';

    const onStatus = ctx.onStatus || (() => {});
    console.log(`[planner] program="${program}" complexity=${complexity_score} | ${reasoning || 'no reasoning'}`);

    // ── Named programs ────────────────────────────────────────────────────
    if (program === 'create_github_project') {
      return this._runNamedProgram_CreateGitHubProject(params, { onStatus });
    }

    if (program === 'update_github_project') {
      return this._runNamedProgram_UpdateGitHubProject(params, { onStatus });
    }

    // ── Custom task list ──────────────────────────────────────────────────
    return this._runCustomTasks(tasks, { onStatus });
  },


  // ─── Named program: create_github_project ───────────────────────────────

  async _runNamedProgram_CreateGitHubProject(params, { onStatus }) {
    const { email, concept_hint } = params;
    if (!email) return 'create_github_project requires params.email — the email address to notify when done';

    const settings = require('../core/Settings').getInstance();
    const githubSettings = settings.get('github');

    if (!githubSettings?.connected || !githubSettings?.accessToken) {
      return 'GitHub is not connected. Open /settings and connect your GitHub account first.';
    }

    const googleSettings = settings.get('google');
    if (!googleSettings?.connected || !googleSettings?.tokens) {
      return 'Google (Gmail) is not connected. Open /settings and connect Google first so the email can be sent.';
    }

    const { build } = require('../pipeline/programs/CreateGitHubProject');
    const pipeline = build({
      githubTool: _tools.github,
      googleTool: _tools.google,
      githubUsername: githubSettings.username,
    });

    const assistantName = settings.get('app')?.name || 'Jennifer';

    try {
      const result = await pipeline.run(
        {
          email,
          concept_hint: concept_hint || null,
          assistantName,
          _client,
        },
        { onStatus },
      );

      const pagesNote = result.pagesUrl ? ` — live at ${result.pagesUrl} (ready in ~1 min)` : '';
      return `Created "${result.concept?.title}" at ${result.repoUrl}${pagesNote} — email sent to ${email}.`;
    } catch (err) {
      console.error('[planner] create_github_project pipeline failed:', err.message);
      return `Project creation failed: ${err.message}`;
    }
  },


  // ─── Named program: update_github_project ──────────────────────────────

  async _runNamedProgram_UpdateGitHubProject(params, { onStatus }) {
    const { repo, improvement_hint, email } = params;
    if (!repo) return 'update_github_project requires params.repo — the repository name to update';

    const settings = require('../core/Settings').getInstance();
    const githubSettings = settings.get('github');

    if (!githubSettings?.connected || !githubSettings?.accessToken) {
      return 'GitHub is not connected. Open /settings and connect your GitHub account first.';
    }

    const { build } = require('../pipeline/programs/UpdateGitHubProject');
    const pipeline = build({
      githubTool: _tools.github,
      googleTool: _tools.google,
      githubUsername: githubSettings.username,
    });

    const assistantName = settings.get('app')?.name || 'Jennifer';

    try {
      const result = await pipeline.run(
        {
          repo,
          improvement_hint: improvement_hint || null,
          email: email || null,
          assistantName,
          _client,
        },
        { onStatus },
      );

      const emailNote = result.emailResult?.toLowerCase().includes('sent') ? ` — update email sent to ${email}` : '';
      return `Updated "${result.repoName}" at ${result.repoUrl}${emailNote}. Live site: ${result.pagesUrl}`;
    } catch (err) {
      console.error('[planner] update_github_project pipeline failed:', err.message);
      return `Project update failed: ${err.message}`;
    }
  },


  // ─── Custom task list (fallback) ────────────────────────────────────────

  async _runCustomTasks(tasks, { onStatus }) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return 'plan_and_execute with program="custom" requires a non-empty tasks array';
    }

    const n = tasks.length;
    const availableToolNames = _client.toolRegistry
      ? _client.toolRegistry.list().filter(name => name !== 'plan_and_execute')
      : [];

    onStatus({
      type: 'plan_start',
      total: n,
      tasks: tasks.map(t => (typeof t === 'string' ? t : t.description)),
    });

    const completedSummaries = [];

    for (let i = 0; i < n; i++) {
      const task = tasks[i];
      const desc = typeof task === 'string' ? task : task.description;
      const toolHint = typeof task === 'object' ? task.tool_hint : null;

      console.log(`[planner/custom] Step ${i + 1}/${n}: ${desc}`);
      onStatus({ type: 'plan_step', step: i + 1, total: n, task: desc, tool_hint: toolHint });

      const prevContext = completedSummaries.length > 0
        ? `Completed steps:\n${completedSummaries
            .map((s, j) => `  ${j + 1}. ${(tasks[j].description || tasks[j]).slice(0, 60)}: ${s}`)
            .join('\n')}\n\n`
        : '';

      const stepSystemPrompt = `You are executing step ${i + 1} of ${n} in a plan.
Available tools: ${availableToolNames.join(', ')}.
Your tools are real — NEVER say you cannot do something when a tool exists for it.
Complete ONLY this step and report the result in 1–2 sentences.`;

      const messages = [
        { role: 'system', content: stepSystemPrompt },
        { role: 'user', content: `${prevContext}Execute: ${desc}` },
      ];

      let result;
      try {
        result = await _client.complete(messages, {
          onStatus,
          excludeTools: ['plan_and_execute'],
        });
      } catch (err) {
        result = `Step failed: ${err.message}`;
        console.error(`[planner/custom] Step ${i + 1} error:`, err.message);
      }

      const summary = String(result).replace(/\n+/g, ' ').slice(0, 400);
      completedSummaries.push(summary);

      onStatus({ type: 'plan_step_done', step: i + 1, total: n, task: desc, result: summary });
    }

    onStatus({ type: 'plan_complete', total: n });

    return `Completed ${n} steps:\n${tasks
      .map((t, i) => `${i + 1}. ${t.description || t}: ${completedSummaries[i].slice(0, 150)}`)
      .join('\n')}`;
  },
};

module.exports = PlannerTool;
