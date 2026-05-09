'use strict';

/**
 * UpdateGitHubProject — deterministic pipeline for improving an existing repo.
 *
 * Steps (hardcoded):
 *   1. Transform: derive repo details from params
 *   2. Tool: read current index.html from GitHub
 *   3. AI: generate improved index.html (given current HTML + improvement hint)
 *   4. Tool: push updated index.html
 *   5. Tool: send email (optional)
 */

const Pipeline = require('../Pipeline');
const { aiGenerate, toolCall, transform } = require('../steps');

function build({ githubTool, emailTool, githubUsername }) {
  return new Pipeline('update_github_project', [

    // ── Step 1: Derive repo details ────────────────────────────────────────
    transform({
      name: 'Derive repo details',
      fn: (ctx) => {
        const repo = ctx.repo;
        return {
          repoName: repo,
          repoUrl: `https://github.com/${githubUsername}/${repo}`,
          pagesUrl: `https://${githubUsername}.github.io/${repo}`,
        };
      },
    }),

    // ── Step 2: Read current index.html ───────────────────────────────────
    toolCall({
      name: 'Read current index.html',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'get_file',
        repo: ctx.repoName,
        file_path: 'index.html',
      }),
      outputKey: 'currentHtml',
      validate: (r) => r.includes('<') ? true : 'Could not read index.html: ' + r,
    }),

    // ── Step 3: Generate improved HTML ────────────────────────────────────
    aiGenerate({
      name: 'Generate improved index.html',
      buildPrompt: (ctx) => `You are improving an existing static HTML page.

Current HTML:
${ctx.currentHtml}

Improvement request: ${ctx.improvement_hint || 'Make it significantly more sophisticated, visually impressive, and interactive.'}

Hard requirements:
- Keep the same project concept and theme
- Start with exactly <!DOCTYPE html> on the first line
- All CSS in a <style> tag (zero external dependencies)
- All JavaScript inline in a <script> tag (NO eval(), NO new Function(), NO setTimeout/setInterval with string arguments)
- Substantially more sophisticated than the current version — not just minor tweaks
- Keep the footer: Made by Jennifer
- End with </html> as the last line

Output ONLY the HTML. First character: <. Last character: >.
Zero explanation. Zero markdown. Just the complete improved HTML file.`,
      outputKey: 'html',
      deslop: false,
      retries: 2,
      validate: (h) => {
        if (!h.includes('<!DOCTYPE html>') && !h.trim().startsWith('<html')) return 'Missing DOCTYPE';
        if (!h.includes('</html>')) return 'Incomplete HTML (no closing </html>)';
        if (h.length < 800) return 'HTML too short — likely incomplete';
        return true;
      },
    }),

    // ── Step 4: Push updated index.html ───────────────────────────────────
    toolCall({
      name: 'Push updated index.html',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'push_file',
        repo: ctx.repoName,
        file_path: 'index.html',
        content: ctx.html,
        message: `Update index.html: ${ctx.improvement_hint || 'improve sophistication and interactivity'}`,
      }),
      outputKey: 'pushResult',
      validate: (r) => r.includes('File pushed') ? true : 'Push failed: ' + r,
    }),

    // ── Step 5: Send email (optional) ─────────────────────────────────────
    toolCall({
      name: 'Send completion email',
      tool: emailTool,
      buildArgs: (ctx) => ({
        to: ctx.email,
        subject: `Jennifer updated: ${ctx.repoName}`,
        body: [
          `Hey,`,
          ``,
          `Jennifer updated ${ctx.repoName} for you.`,
          ``,
          `Change: ${ctx.improvement_hint || 'improved sophistication and interactivity'}`,
          ``,
          `Repo: ${ctx.repoUrl}`,
          `Live site: ${ctx.pagesUrl}`,
          ``,
          `Made by Jennifer`,
        ].join('\n'),
      }),
      outputKey: 'emailResult',
      optional: true,
    }),

  ]);
}

module.exports = { build };
