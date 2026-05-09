'use strict';

/**
 * Step factory functions for the Pipeline runner.
 *
 * Three primitives:
 *   aiGenerate  — model generates text, no tool calls, optional validation + deslop
 *   toolCall    — deterministic tool execution with validated output
 *   transform   — pure synchronous function on context (no I/O)
 *
 * Every step returns a plain object that Pipeline.run() shallow-merges into ctx.
 * The 'output' key is reserved for display; all other keys become ctx properties.
 */

// ─── Deslop ──────────────────────────────────────────────────────────────────
// Source: https://github.com/97115104/97115104-writing-profile
// Rules from §1 Forbidden patterns and §2 Forbidden lexicon of writing-profile.md

const DESLOP_RULES = [
  // § 1 — Forbidden constructions
  [/ — /g,                     ', '],        // em dash with spaces
  [/—/g,                       ','],         // bare em dash
  [/\brather than\b/gi,        'and not'],
  [/\bit is not ([\w\s]+?) but ([\w\s]+)/gi, (_, a, b) => `${b.trim()}, and not ${a.trim()}`],
  [/\bnot ([\w\s]+?) but ([\w\s]+)/gi,       (_, a, b) => `${b.trim()}, and not ${a.trim()}`],

  // § 2 — Forbidden lexicon
  [/\bleverage[sd]?\b/gi,                    'use'],
  [/\brobust(?:ly|ness)?\b/gi,              'reliable'],
  [/\bdelves? into\b/gi,                    'examines'],
  [/\bdelves?\b/gi,                         'examines'],
  [/\bunleash(?:es|ed)?\b/gi,              'release'],
  [/\bin conclusion[,.]?\s*/gi,             ''],
  [/\bmoreover[,.]?\s*/gi,                 ''],
  [/\bfurthermore[,.]?\s*/gi,              ''],
  [/\btransformative\b/gi,                 'significant'],
  [/\bparadigm[-\s]shifting\b/gi,          'consequential'],
  [/\bpivotal\b/gi,                        'important'],
  [/\bparamount\b/gi,                      'important'],
  [/\bcrucial\b/gi,                        'important'],
  [/\brevolutionize[sd]?\b/gi,             'change'],
  [/\bunprecedented\b/gi,                  'unusual'],
  [/\bseamless(?:ly|ness)?\b/gi,          'smooth'],
  [/\bcomprehensive(?:ly)?\b/gi,          'thorough'],
  [/\bholistic(?:ally)?\b/gi,             'complete'],
  [/\bsynerg(?:y|ies|istic(?:ally)?)\b/gi, 'coordination'],
  [/\bgame[-\s]changer[s]?\b/gi,          'shift'],
  [/\bdisruptive?\b/gi,                   'consequential'],
  [/\bnavigate[sd]?\b/gi,                 'address'],
  [/\bin today['']?s world[,.]?\s*/gi,    ''],
  [/\bin the realm of\b/gi,               'in'],
  [/\bdive into\b/gi,                     'examine'],

  // Common AI slop openers
  [/^(Sure|Certainly|Absolutely|Of course|Great|Excellent|Perfect)[!,]?\s+/i, ''],
  [/^I'd be happy to\s+/i,                ''],
  [/^I'll\s+/i,                           ''],
];

function deslop(text) {
  let out = text;
  for (const [pattern, replacement] of DESLOP_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}


// ─── aiGenerate ──────────────────────────────────────────────────────────────

/**
 * Calls the model for text generation only — no tools, no multi-step reasoning.
 * The model's only job in this step is to produce content.
 *
 * @param {object} opts
 * @param {string} opts.name          Display name for the step
 * @param {string|function} opts.buildPrompt  Prompt string or (ctx) => string
 * @param {string} opts.outputKey     Key to store result under in ctx
 * @param {boolean} [opts.parseJSON]  Strip fences and JSON.parse the output
 * @param {function} [opts.validate]  (output) => true | errorString
 * @param {boolean} [opts.deslop]     Apply deslop rules to text output
 * @param {number} [opts.retries]     How many attempts (default 2)
 * @param {string} [opts.toolHint]    Label shown in UI
 */
function aiGenerate({ name, buildPrompt, outputKey, parseJSON = false, validate, deslop: applyDeslop = false, retries = 2, toolHint = null }) {
  return {
    name,
    toolHint,
    retries,
    async execute(ctx) {
      if (!ctx._client?.generate) throw new Error('ctx._client.generate() not available — inject InferenceClient into ctx');

      const prompt = typeof buildPrompt === 'function' ? buildPrompt(ctx) : buildPrompt;
      let raw = await ctx._client.generate(prompt);

      // Strip markdown code fences that models commonly wrap output in
      raw = raw.replace(/^```(?:json|html|markdown|md|javascript|js)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();

      let output = raw;

      if (parseJSON) {
        // Allow model to include surrounding explanation — extract the JSON object/array
        const jsonMatch = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (!jsonMatch) throw new Error('Model did not return valid JSON — got: ' + output.slice(0, 200));
        try {
          output = JSON.parse(jsonMatch[1]);
        } catch (e) {
          throw new Error('Model returned malformed JSON: ' + e.message + '\nInput: ' + jsonMatch[1].slice(0, 300));
        }
      } else if (applyDeslop) {
        output = deslop(output);
      }

      if (validate) {
        const verdict = validate(output);
        if (verdict !== true) throw new Error('Output validation: ' + verdict);
      }

      const preview = typeof output === 'object' ? JSON.stringify(output).slice(0, 120) : String(output).slice(0, 120);
      return { [outputKey]: output, output: preview };
    },
  };
}


// ─── toolCall ─────────────────────────────────────────────────────────────────

/**
 * Calls a tool deterministically — args are built from ctx by the program,
 * not decided by the model.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {object} opts.tool       Tool object with .execute(args) → string
 * @param {function} opts.buildArgs  (ctx) => args
 * @param {string} opts.outputKey
 * @param {function} [opts.validate]  (resultString) => true | errorString
 * @param {boolean} [opts.optional]  Don't fail pipeline on error
 */
function toolCall({ name, tool, buildArgs, outputKey, validate, optional = false }) {
  return {
    name,
    toolHint: tool.name,
    optional,
    retries: 1,
    async execute(ctx) {
      const args = typeof buildArgs === 'function' ? buildArgs(ctx) : buildArgs;
      const result = String(await tool.execute(args));

      // Detect tool-returned error strings
      if (
        result.startsWith('GitHub error:') ||
        result.startsWith('Error executing') ||
        result.startsWith('Failed to') ||
        result.toLowerCase().startsWith('error:')
      ) {
        throw new Error(result);
      }

      if (validate) {
        const verdict = validate(result);
        if (verdict !== true) throw new Error('Tool result validation: ' + verdict);
      }

      return { [outputKey]: result, output: result };
    },
  };
}


// ─── transform ────────────────────────────────────────────────────────────────

/**
 * Pure synchronous function on context — no I/O, no model calls.
 * Use for deriving values (slugifying names, extracting repo URLs, etc.)
 */
function transform({ name, fn }) {
  return {
    name,
    toolHint: null,
    retries: 1,
    execute(ctx) {
      const updates = fn(ctx);
      return { ...updates, output: JSON.stringify(updates).slice(0, 120) };
    },
  };
}


module.exports = { aiGenerate, toolCall, transform, deslop };
