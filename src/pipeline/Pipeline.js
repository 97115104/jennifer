'use strict';

/**
 * Deterministic pipeline runner.
 *
 * The model generates content; the pipeline sequences, validates, and calls
 * tools. No intelligence is expected from the model about what to do next —
 * the program handles that.
 *
 * Each step returns a partial context object that is shallow-merged into ctx.
 * The 'output' key in the return is used for UI display only.
 */
class Pipeline {
  constructor(name, steps) {
    this.name = name;
    this.steps = steps;
  }

  async run(initialCtx, { onStatus = () => {} } = {}) {
    const ctx = { ...initialCtx };
    const n = this.steps.length;

    onStatus({
      type: 'plan_start',
      pipeline: this.name,
      total: n,
      tasks: this.steps.map(s => s.name),
    });

    for (let i = 0; i < n; i++) {
      const step = this.steps[i];
      const retries = step.retries ?? 1;

      console.log(`[pipeline:${this.name}] Step ${i + 1}/${n}: ${step.name}`);
      onStatus({ type: 'plan_step', step: i + 1, total: n, task: step.name, tool_hint: step.toolHint ?? null });

      let result;
      let lastErr;

      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          result = await step.execute(ctx);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.error(`[pipeline] "${step.name}" attempt ${attempt + 1}/${retries} failed: ${err.message}`);
          if (attempt < retries - 1) {
            console.log('[pipeline] Retrying...');
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }

      if (lastErr) {
        if (step.optional) {
          console.warn(`[pipeline] Optional step "${step.name}" skipped: ${lastErr.message}`);
          result = { output: `skipped: ${lastErr.message}` };
        } else {
          throw new Error(`Step "${step.name}" failed after ${retries} attempt(s): ${lastErr.message}`);
        }
      }

      // Merge step output into shared context (excluding internal 'output' display key)
      const { output, ...ctxUpdates } = result;
      Object.assign(ctx, ctxUpdates);

      const preview = String(output ?? ctxUpdates[Object.keys(ctxUpdates)[0]] ?? '').slice(0, 120);
      console.log(`[pipeline] ✓ Step ${i + 1}: ${preview}`);
      onStatus({ type: 'plan_step_done', step: i + 1, total: n, task: step.name, result: preview });
    }

    onStatus({ type: 'plan_complete', pipeline: this.name, total: n });
    return ctx;
  }
}

module.exports = Pipeline;
