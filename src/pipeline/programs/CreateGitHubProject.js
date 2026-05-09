'use strict';

/**
 * CreateGitHubProject — deterministic pipeline.
 *
 * Steps (hardcoded, not decided by the model):
 *   1. AI: invent project concept → JSON { slug, title, description, theme, palette }
 *   2. Transform: derive repoName, repoUrl, pagesUrl from slug
 *   3. Tool: create_repo
 *   4. AI: generate index.html
 *   5. Tool: push index.html
 *   6. AI: generate README.md
 *   7. Tool: push README.md
 *   8. Tool: enable_pages (optional — Pages live in ~1 min after this)
 *   9. Tool: send_email
 *
 * The model generates content (steps 1, 4, 6).
 * The program controls everything else.
 */

const Pipeline = require('../Pipeline');
const { aiGenerate, toolCall, transform } = require('../steps');

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function build({ githubTool, googleTool, githubUsername }) {
  return new Pipeline('create_github_project', [

    // ── Step 1: Concept ────────────────────────────────────────────────────
    aiGenerate({
      name: 'Invent project concept',
      buildPrompt: (ctx) => `You are a creative web developer inventing a unique static web project.
${ctx.concept_hint ? `Inspiration: ${ctx.concept_hint}` : 'Make it surprising and original — something a portfolio would be proud of.'}

Output ONLY a JSON object. No explanation, no markdown fences, just the raw JSON:
{
  "slug": "kebab-case-repo-name-under-25-chars",
  "title": "Human Readable Title",
  "description": "One sentence: what the page shows or does",
  "theme": "specific visual style (e.g. 'retro synthwave neon grid', 'botanical ink illustration', 'brutalist monochrome')",
  "palette": "#rrggbb, #rrggbb, #rrggbb"
}`,
      outputKey: 'concept',
      parseJSON: true,
      retries: 3,
      validate: (v) => {
        if (!v || typeof v !== 'object') return 'Not an object';
        if (!v.slug) return 'Missing slug';
        if (!v.title) return 'Missing title';
        if (!v.description) return 'Missing description';
        return true;
      },
    }),

    // ── Step 2: Derive repo name ───────────────────────────────────────────
    transform({
      name: 'Derive repo name',
      fn: (ctx) => {
        const slug = slugify(ctx.concept.slug || ctx.concept.title);
        return {
          repoName: slug,
          repoTitle: ctx.concept.title,
          repoUrl: `https://github.com/${githubUsername}/${slug}`,
          pagesUrl: `https://${githubUsername}.github.io/${slug}`,
        };
      },
    }),

    // ── Step 3: Create repo ────────────────────────────────────────────────
    toolCall({
      name: 'Create GitHub repository',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'create_repo',
        name: ctx.repoName,
        description: ctx.concept.description,
      }),
      outputKey: 'repoResult',
      validate: (r) => r.includes('github.com') ? true : 'Repo creation failed: ' + r,
    }),

    // ── Step 4: Generate HTML ──────────────────────────────────────────────
    aiGenerate({
      name: 'Generate index.html',
      buildPrompt: (ctx) => `Create a complete, visually impressive static HTML page.

Project: "${ctx.concept.title}"
What it is: ${ctx.concept.description}
Visual theme: ${ctx.concept.theme}
Color palette: ${ctx.concept.palette || '#1a1a2e, #16213e, #0f3460'}

Hard requirements:
- Start with exactly <!DOCTYPE html> on the first line
- All CSS in a <style> tag (zero external dependencies)
- All JavaScript inline in a <script> tag if needed (NO eval(), NO new Function(), NO setTimeout/setInterval with string arguments)
- At least two distinct CSS keyframe animations
- Full-viewport creative layout — not a centered card on white
- A clear hero that names the project and what it does
- Genuine creative execution of the visual theme
- Footer containing exactly: Made by Jennifer
- End with </html> as the last line

Output ONLY the HTML. First character: <. Last character: >.
Zero explanation. Zero markdown. Just the complete HTML file.`,
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

    // ── Step 5: Push index.html ────────────────────────────────────────────
    toolCall({
      name: 'Push index.html',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'push_file',
        repo: ctx.repoName,
        file_path: 'index.html',
        content: ctx.html,
        message: `Add ${ctx.repoTitle}: index.html`,
      }),
      outputKey: 'htmlPushResult',
      validate: (r) => r.includes('File pushed') ? true : 'Push failed: ' + r,
    }),

    // ── Step 6: Generate README ────────────────────────────────────────────
    aiGenerate({
      name: 'Generate README.md',
      buildPrompt: (ctx) => `Write a README.md for this GitHub project.

# ${ctx.concept.title}

Project: ${ctx.concept.title}
Description: ${ctx.concept.description}
Repo: ${ctx.repoUrl}

Rules:
- Start with: # ${ctx.concept.title}
- 3 to 5 sentences total
- Tell the reader to open index.html in a browser to view it
- No bullet lists, no sub-headers, no em dashes
- Direct and specific, no filler phrases
- End with a blank line

Output only the README content.`,
      outputKey: 'readme',
      deslop: true,
      retries: 2,
      validate: (r) => r.length > 80 ? true : 'README too short',
    }),

    // ── Step 7: Push README ────────────────────────────────────────────────
    toolCall({
      name: 'Push README.md',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'push_file',
        repo: ctx.repoName,
        file_path: 'README.md',
        content: ctx.readme,
        message: 'Add README.md',
      }),
      outputKey: 'readmePushResult',
    }),

    // ── Step 8: Enable GitHub Pages ────────────────────────────────────────
    toolCall({
      name: 'Enable GitHub Pages',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'enable_pages',
        repo: ctx.repoName,
      }),
      outputKey: 'pagesResult',
      optional: true,
    }),

    // ── Step 9: Send email ─────────────────────────────────────────────────
    toolCall({
      name: 'Send completion email',
      tool: googleTool,
      buildArgs: (ctx) => ({
        action: 'send_email',
        to: ctx.email,
        subject: `Jennifer built: ${ctx.concept.title}`,
        body: [
          `Hey,`,
          ``,
          `Jennifer just created "${ctx.concept.title}" for you.`,
          ``,
          `${ctx.concept.description}`,
          ``,
          `Repo: ${ctx.repoUrl}`,
          `Live site: ${ctx.pagesUrl}`,
          ``,
          `The live site takes about a minute to build after the first push.`,
          ``,
          `Made by Jennifer`,
        ].join('\n'),
      }),
      outputKey: 'emailResult',
      validate: (r) => r.toLowerCase().includes('sent') ? true : 'Email send failed: ' + r,
    }),

  ]);
}

module.exports = { build };
