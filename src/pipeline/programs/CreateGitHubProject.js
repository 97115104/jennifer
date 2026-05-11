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

function isSpeedTestProject(ctx) {
  const text = [
    ctx.concept_hint,
    ctx.concept?.title,
    ctx.concept?.description,
  ].filter(Boolean).join(' ');
  return /\b(internet speed|speed test|speedtest|connection speed|bandwidth)\b/i.test(text);
}

function buildSpeedTestConcept() {
  return {
    slug: 'connection-speed-check',
    title: 'Connection Speed Check',
    description: 'A GitHub Pages web app that estimates browser download speed and includes a Python script for checking the current connection from the terminal.',
    theme: 'network operations dashboard',
    palette: '#08111f, #53d7ff, #7cffb2',
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSpeedTestPython() {
  return `#!/usr/bin/env python3
"""Simple internet speed check for the current connection.

This script downloads a sample payload from Cloudflare's speed endpoint and
prints an approximate download speed. It uses only the Python standard library.
"""

import argparse
import statistics
import time
import urllib.request


DEFAULT_URL = "https://speed.cloudflare.com/__down?bytes=25000000"


def measure_download(url: str, runs: int) -> list[float]:
    speeds = []
    for run in range(1, runs + 1):
        started = time.perf_counter()
        bytes_read = 0
        request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=60) as response:
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                bytes_read += len(chunk)

        elapsed = max(time.perf_counter() - started, 0.001)
        mbps = (bytes_read * 8) / elapsed / 1_000_000
        speeds.append(mbps)
        print(f"Run {run}: {mbps:.2f} Mbps over {elapsed:.2f}s")
    return speeds


def main() -> None:
    parser = argparse.ArgumentParser(description="Check approximate internet download speed.")
    parser.add_argument("--url", default=DEFAULT_URL, help="Download URL to test against")
    parser.add_argument("--runs", type=int, default=3, help="Number of test runs")
    args = parser.parse_args()

    speeds = measure_download(args.url, max(args.runs, 1))
    print("")
    print(f"Average: {statistics.mean(speeds):.2f} Mbps")
    print(f"Best:    {max(speeds):.2f} Mbps")


if __name__ == "__main__":
    main()
`;
}

function buildSpeedTestHtml(ctx) {
  const title = escapeHtml(ctx.concept?.title || 'Connection Speed Check');
  const description = escapeHtml(ctx.concept?.description || 'A static web app that estimates current browser download speed and includes a Python companion script.');
  const assistantName = escapeHtml(ctx.assistantName || 'Jennifer');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08111f;
      --panel: rgba(255, 255, 255, 0.08);
      --text: #eef6ff;
      --muted: #9fb4c7;
      --accent: #53d7ff;
      --accent-2: #7cffb2;
      --warn: #ffd166;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 20% 20%, rgba(83, 215, 255, 0.24), transparent 28rem),
        radial-gradient(circle at 80% 10%, rgba(124, 255, 178, 0.18), transparent 24rem),
        linear-gradient(135deg, #08111f 0%, #0c2038 55%, #07101c 100%);
      color: var(--text);
      overflow-x: hidden;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
      background-size: 42px 42px;
      mask-image: linear-gradient(to bottom, black, transparent 85%);
      animation: grid-drift 14s linear infinite;
    }

    main {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 56px 0 28px;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 28px;
      align-items: stretch;
    }

    h1 {
      margin: 0;
      max-width: 780px;
      font-size: clamp(2.4rem, 7vw, 6.6rem);
      line-height: 0.92;
      letter-spacing: 0;
    }

    .lede {
      max-width: 700px;
      margin: 22px 0 0;
      font-size: 1.08rem;
      line-height: 1.7;
      color: var(--muted);
    }

    .meter {
      position: relative;
      min-height: 340px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      background: rgba(7, 16, 28, 0.72);
      padding: 26px;
      overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,0.28);
    }

    .pulse {
      position: absolute;
      width: 220px;
      height: 220px;
      left: 50%;
      top: 44%;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      border: 2px solid rgba(83, 215, 255, 0.34);
      animation: pulse-ring 2.4s ease-out infinite;
    }

    .speed {
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      min-height: 230px;
      text-align: center;
    }

    .speed strong {
      display: block;
      font-size: clamp(2.8rem, 9vw, 5.4rem);
      color: var(--accent-2);
      line-height: 1;
    }

    .speed span {
      color: var(--muted);
      text-transform: uppercase;
      font-size: 0.78rem;
      letter-spacing: 0.14em;
    }

    button {
      width: 100%;
      border: 0;
      border-radius: 8px;
      padding: 14px 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #04101c;
      font-size: 1rem;
      font-weight: 800;
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.62;
      cursor: wait;
    }

    .details {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-top: 24px;
    }

    .tile {
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      padding: 18px;
      background: var(--panel);
      min-height: 120px;
    }

    .tile b {
      display: block;
      margin-bottom: 10px;
      color: var(--accent);
    }

    .tile p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    code {
      display: block;
      margin-top: 18px;
      padding: 16px;
      border-radius: 8px;
      background: rgba(0,0,0,0.32);
      color: var(--warn);
      white-space: pre-wrap;
    }

    footer {
      margin-top: 34px;
      color: var(--muted);
    }

    @keyframes pulse-ring {
      0% { transform: translate(-50%, -50%) scale(0.72); opacity: 0.95; }
      100% { transform: translate(-50%, -50%) scale(1.42); opacity: 0; }
    }

    @keyframes grid-drift {
      from { background-position: 0 0, 0 0; }
      to { background-position: 42px 42px, 42px 42px; }
    }

    @media (max-width: 820px) {
      .hero, .details { grid-template-columns: 1fr; }
      main { padding-top: 32px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>${title}</h1>
        <p class="lede">${description}</p>
        <div class="details">
          <div class="tile">
            <b>Browser test</b>
            <p>The page downloads a test payload and estimates Mbps from bytes transferred over elapsed time.</p>
          </div>
          <div class="tile">
            <b>Python script</b>
            <p>The repo also includes speed_test.py for a local terminal check of the current connection.</p>
          </div>
          <div class="tile">
            <b>Reality check</b>
            <p>Browser tests are approximate. VPNs, Wi-Fi, throttling, cache, and server distance can affect results.</p>
          </div>
        </div>
        <code>python3 speed_test.py --runs 3</code>
      </div>
      <aside class="meter" aria-label="Speed test meter">
        <div class="pulse"></div>
        <div class="speed">
          <div>
            <strong id="speed-value">--</strong>
            <span id="speed-label">Mbps</span>
          </div>
        </div>
        <button id="run-test" type="button">Run speed check</button>
      </aside>
    </section>
    <footer>Made by ${assistantName}</footer>
  </main>
  <script>
    const button = document.getElementById('run-test');
    const speedValue = document.getElementById('speed-value');
    const speedLabel = document.getElementById('speed-label');
    const endpoint = 'https://speed.cloudflare.com/__down?bytes=25000000';

    async function runSpeedCheck() {
      button.disabled = true;
      button.textContent = 'Testing...';
      speedValue.textContent = '...';
      speedLabel.textContent = 'Downloading sample';

      try {
        const started = performance.now();
        const response = await fetch(endpoint + '&cacheBust=' + Date.now(), { cache: 'no-store' });
        const buffer = await response.arrayBuffer();
        const elapsedSeconds = Math.max((performance.now() - started) / 1000, 0.001);
        const mbps = (buffer.byteLength * 8) / elapsedSeconds / 1000000;
        speedValue.textContent = mbps.toFixed(1);
        speedLabel.textContent = 'Mbps estimate';
      } catch (error) {
        speedValue.textContent = 'blocked';
        speedLabel.textContent = 'Try the Python script';
      } finally {
        button.disabled = false;
        button.textContent = 'Run speed check';
      }
    }

    button.addEventListener('click', runSpeedCheck);
  </script>
</body>
</html>`;
}

function buildReadme(ctx) {
  const lines = [
    `# ${ctx.concept.title}`,
    '',
  ];

  if (isSpeedTestProject(ctx)) {
    lines.push(`${ctx.concept.title} is a GitHub Pages web app that estimates browser download speed from a live test payload.`);
    lines.push('The repository also includes speed_test.py, a standard-library Python script for checking the current connection from the terminal.');
    lines.push('Open index.html in a browser to view the web app, or run python3 speed_test.py --runs 3 for the local script.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`${ctx.concept.title} is a static GitHub Pages project.`);
  lines.push(ctx.concept.description);
  lines.push('Open index.html in a browser to view it.');
  lines.push('');
  return lines.join('\n');
}

function build({ githubTool, googleTool, githubUsername }) {
  return new Pipeline('create_github_project', [

    // ── Step 1: Deterministic concept for known project types ──────────────
    transform({
      name: 'Prepare requested project concept',
      fn: (ctx) => {
        if (!isSpeedTestProject(ctx)) return { output: 'No exact project template matched' };
        return {
          concept: buildSpeedTestConcept(),
          output: 'Prepared speed test project concept',
        };
      },
    }),

    // ── Step 2: Concept ────────────────────────────────────────────────────
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
      maxTokens: 1500,
      temperature: 0.7,
      skipIf: (ctx) => Boolean(ctx.concept),
      validate: (v) => {
        if (!v || typeof v !== 'object') return 'Not an object';
        if (!v.slug) return 'Missing slug';
        if (!v.title) return 'Missing title';
        if (!v.description) return 'Missing description';
        return true;
      },
    }),

    // ── Step 3: Derive repo name ───────────────────────────────────────────
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

    // ── Step 4: Create repo ────────────────────────────────────────────────
    toolCall({
      name: 'Create GitHub repository',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'create_repo',
        name: ctx.repoName,
        description: ctx.concept.description,
        reason: 'The user asked for a GitHub repository to be created.',
      }),
      outputKey: 'repoResult',
      validate: (r) => r.includes('github.com') ? true : 'Repo creation failed: ' + r,
    }),

    // ── Step 5: Use deterministic templates when the request is specific ──
    transform({
      name: 'Prepare specialized project files',
      fn: (ctx) => {
        if (!isSpeedTestProject(ctx)) {
          return { supportFiles: {}, output: 'No specialized template needed' };
        }
        return {
          html: buildSpeedTestHtml(ctx),
          supportFiles: {
            'speed_test.py': buildSpeedTestPython(),
          },
          output: 'Generated speed test web app and Python script',
        };
      },
    }),

    // ── Step 6: Generate HTML ──────────────────────────────────────────────
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
- Footer containing exactly: Made by ${ctx.assistantName || 'Jennifer'}
- End with </html> as the last line
- Keep the complete file under 500 lines so it cannot be truncated
- If the user requested a script, mention any companion script in the page UI

Output ONLY the HTML. First character: <. Last character: >.
Zero explanation. Zero markdown. Just the complete HTML file.`,
      outputKey: 'html',
      deslop: false,
      retries: 4,
      maxTokens: 20000,
      temperature: 0.55,
      skipIf: (ctx) => Boolean(ctx.html),
      validate: (h) => {
        const trimmed = String(h || '').trim();
        if (!trimmed.includes('<!DOCTYPE html>') && !trimmed.startsWith('<html')) return 'Missing DOCTYPE';
        if (!trimmed.endsWith('</html>')) return 'Incomplete HTML (no closing </html> as the final line)';
        if (h.length < 800) return 'HTML too short — likely incomplete';
        return true;
      },
    }),

    // ── Step 7: Push index.html ────────────────────────────────────────────
    toolCall({
      name: 'Push index.html',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'push_file',
        repo: ctx.repoName,
        file_path: 'index.html',
        content: ctx.html,
        message: `Add ${ctx.repoTitle}: index.html`,
        reason: 'The user asked for the generated web app to be hosted in a GitHub repository.',
      }),
      outputKey: 'htmlPushResult',
      validate: (r) => r.includes('File pushed') ? true : 'Push failed: ' + r,
    }),

    // ── Step 8: Push support script if the project needs one ───────────────
    toolCall({
      name: 'Push speed_test.py',
      tool: githubTool,
      skipIf: (ctx) => !ctx.supportFiles?.['speed_test.py'],
      buildArgs: (ctx) => ({
        action: 'push_file',
        repo: ctx.repoName,
        file_path: 'speed_test.py',
        content: ctx.supportFiles['speed_test.py'],
        message: 'Add Python speed test script',
        reason: 'The user asked for a Python script to be included in the GitHub repository.',
      }),
      outputKey: 'scriptPushResult',
      validate: (r) => r.includes('File pushed') ? true : 'Script push failed: ' + r,
    }),

    // ── Step 9: Prepare README ─────────────────────────────────────────────
    transform({
      name: 'Prepare README.md',
      fn: (ctx) => ({
        readme: buildReadme(ctx),
        output: 'README.md prepared',
      }),
    }),

    // ── Step 10: Generate README ───────────────────────────────────────────
    aiGenerate({
      name: 'Generate README.md',
      buildPrompt: (ctx) => `Write a README.md for this GitHub project.

# ${ctx.concept.title}

Project: ${ctx.concept.title}
Description: ${ctx.concept.description}
Repo: ${ctx.repoUrl}
${ctx.supportFiles?.['speed_test.py'] ? 'Support file: speed_test.py is included for local terminal speed checks.' : ''}

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
      maxTokens: 1200,
      temperature: 0.45,
      skipIf: (ctx) => Boolean(ctx.readme),
      validate: (r) => r.length > 80 ? true : 'README too short',
    }),

    // ── Step 11: Push README ───────────────────────────────────────────────
    toolCall({
      name: 'Push README.md',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'push_file',
        repo: ctx.repoName,
        file_path: 'README.md',
        content: ctx.readme,
        message: 'Add README.md',
        reason: 'The user asked for a complete GitHub project, which requires repository documentation.',
      }),
      outputKey: 'readmePushResult',
    }),

    // ── Step 12: Enable GitHub Pages ───────────────────────────────────────
    toolCall({
      name: 'Enable GitHub Pages',
      tool: githubTool,
      buildArgs: (ctx) => ({
        action: 'enable_pages',
        repo: ctx.repoName,
        reason: 'The user asked for the web app to be hosted through GitHub Pages.',
      }),
      outputKey: 'pagesResult',
      optional: true,
    }),

    // ── Step 13: Send email ────────────────────────────────────────────────
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
          `${ctx.assistantName || 'Jennifer'} just created "${ctx.concept.title}" for you.`,
          ``,
          `${ctx.concept.description}`,
          ``,
          `Repo: ${ctx.repoUrl}`,
          `Live site: ${ctx.pagesUrl}`,
          ctx.supportFiles?.['speed_test.py'] ? `Python script: ${ctx.repoUrl}/blob/main/speed_test.py` : null,
          ``,
          `The live site takes about a minute to build after the first push.`,
          ``,
          `Made by ${ctx.assistantName || 'Jennifer'}`,
        ].filter(line => line !== null).join('\n'),
        reason: 'The user asked to receive the GitHub Pages link by email.',
      }),
      outputKey: 'emailResult',
      validate: (r) => r.toLowerCase().includes('sent') ? true : 'Email send failed: ' + r,
    }),

  ]);
}

module.exports = { build };
