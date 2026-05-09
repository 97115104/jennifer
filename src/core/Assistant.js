'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const Conversation = require('./Conversation');
const MemoryStore = require('./MemoryStore');
const Settings = require('./Settings');
const InferenceClient = require('../inference/InferenceClient');

function getAssistantName() {
  try {
    return Settings.getInstance().get('app')?.name || 'Jennifer';
  } catch {
    return 'Jennifer';
  }
}

function buildSystemPrompt(name = 'Jennifer') {
  return `You are ${name}, a voice AI assistant with real tools that execute real actions.

YOUR TOOLS ARE REAL. They create actual GitHub repositories, send actual emails, fetch actual web pages, and run actual shell commands. NEVER say "I cannot", "I'm not able to", or "I don't have the ability to" when a tool exists for the task. Use the tool.

STEP 1 — ASSESS COMPLEXITY (do this silently before every response):
  1–40  Simple    one answer or one tool
  41–65 Moderate  two tools, no dependencies
  66+   Complex   three or more tools, OR any step depends on a previous step's output

STEP 2 — ROUTE:
  Complexity < 66  → use tools inline (up to 2 in sequence)
  Complexity >= 66 → your FIRST and ONLY action is to call plan_and_execute
                     plan_and_execute handles ALL subsequent steps internally
                     do NOT call github/send_email/etc yourself after calling plan_and_execute

TOOL ROUTING:
  github           → ALL GitHub: create_repo, push_file, list_repos, get_user
  send_email       → send email via Gmail
  fetch_url        → fetch web pages
  execute_shell    → run shell commands
  write_file       → save local files
  read_file        → read local files
  memory_lookup    → resolve a saved name/site/variable → call BEFORE send_email or fetch_url
  plan_and_execute → complexity ≥ 66 — ALWAYS call this first, never do multi-step work inline

CONCRETE EXAMPLE — this request scores 85, triggers plan_and_execute:
  User: "create a GitHub project with a creative web page and email me when done"
  You call: plan_and_execute({
    complexity_score: 85,
    reasoning: "Needs create_repo + push_file + send_email — 3 tools with output dependencies",
    tasks: [
      { description: "Decide on a creative project concept and name", tool_hint: null },
      { description: "Create a GitHub repo with the chosen name", tool_hint: "github" },
      { description: "Write and push a creative index.html to the repo", tool_hint: "github" },
      { description: "Push a README.md describing the project", tool_hint: "github" },
      { description: "Send email to [address] with the repo link from step 2", tool_hint: "send_email" }
    ]
  })
  Then plan_and_execute runs all steps and returns a summary.
  You narrate the result in 2–3 spoken sentences.

VOICE RULES:
  - Responses spoken aloud: no markdown, bullets, asterisks, or code blocks
  - Concise — 1–2 sentences unless asked for detail
  - Announce what you're doing: "Let me plan this out and get started..."`;
}

class Assistant extends EventEmitter {
  constructor({ sttProvider, ttsProvider, toolRegistry }) {
    super();
    this.stt = sttProvider;
    this.tts = ttsProvider;
    this.tools = toolRegistry;
    this.inference = new InferenceClient(toolRegistry);
    this.conversation = new Conversation(buildSystemPrompt(getAssistantName()));
  }

  _messagesForInference(text) {
    const messages = this.conversation.getMessages();
    messages[0] = { role: 'system', content: buildSystemPrompt(getAssistantName()) };

    const memoryMatches = MemoryStore.lookup(text, 'any', 8);
    const memoryContext = MemoryStore.formatForPrompt(memoryMatches);
    if (memoryContext) {
      console.log(`[assistant] Memory context matched: ${memoryMatches.map(entry => `${entry.type}:${entry.key}`).join(', ')}`);
      messages.splice(1, 0, { role: 'system', content: memoryContext });
    }

    return messages;
  }

  async initialize() {
    await this.stt.initialize();
    try {
      await this.tts.initialize();
    } catch (err) {
      console.warn(`[assistant] TTS init warning: ${err.message}`);
    }
    console.log('[assistant] Ready');
  }

  async processAudio(audioBuffer, mimeType = 'audio/webm') {
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const inputPath = path.join(os.tmpdir(), `jennifer_in_${uuidv4()}.${ext}`);
    fs.writeFileSync(inputPath, audioBuffer);
    console.log(`[assistant] Audio received: ${(audioBuffer.length / 1024).toFixed(1)}KB (${mimeType}) → ${inputPath}`);

    let transcript;
    try {
      this.emit('status', { state: 'transcribing', message: 'Transcribing...' });
      transcript = await this.stt.transcribe(inputPath);
    } finally {
      fs.unlink(inputPath, () => {});
    }

    if (!transcript || transcript.trim().length < 2) {
      console.warn('[assistant] Empty transcript — audio may be too short or silent');
      throw new Error('Could not transcribe audio — try speaking more clearly');
    }

    console.log(`[assistant] Transcript: "${transcript}"`);
    return this.processText(transcript);
  }

  async processText(text) {
    console.log(`[assistant] Processing text: "${text}"`);
    this.emit('transcript', { text });
    this.emit('status', { state: 'thinking', message: 'Thinking...' });

    this.conversation.addUser(text);

    const t0 = Date.now();
    const responseText = await this.inference.complete(
      this._messagesForInference(text),
      { onStatus: (event) => this.emit('tool_event', event) }
    );
    console.log(`[assistant] Inference complete in ${Date.now() - t0}ms`);

    this.conversation.addAssistant(responseText);
    this.emit('response', { text: responseText });

    const ttsProvider = this.tts?.constructor?.name === 'CoquiTTSProvider' ? 'coqui' : 'system';
    const ttsStartMessage = ttsProvider === 'coqui' ? 'Generating cloned speech...' : 'Preparing speech...';
    this.emit('status', { state: 'speaking', message: ttsStartMessage });
    this.emit('tts_progress', {
      provider: ttsProvider,
      phase: 'start',
      progress: ttsProvider === 'coqui' ? 8 : 0,
      message: ttsStartMessage,
    });

    const audioPath = path.join(os.tmpdir(), `jennifer_out_${uuidv4()}.mp3`);
    console.log(`[assistant] Synthesizing TTS → ${audioPath}`);
    const t1 = Date.now();
    try {
      await this.tts.synthesize(responseText, audioPath);
      const elapsedMs = Date.now() - t1;
      console.log(`[assistant] TTS done in ${elapsedMs}ms`);
      this.emit('tts_progress', {
        provider: ttsProvider,
        phase: 'ready',
        progress: 100,
        message: ttsProvider === 'coqui' ? 'Cloned speech ready' : 'Speech ready',
        elapsedMs,
      });
    } catch (err) {
      this.emit('tts_progress', {
        provider: ttsProvider,
        phase: 'error',
        progress: 0,
        message: `Speech generation failed: ${err.message}`,
      });
      throw err;
    }

    return { transcript: text, response: responseText, audioPath };
  }

  resetConversation() {
    this.conversation.reset(true);
    this.emit('status', { state: 'idle', message: 'Conversation reset' });
  }
}

module.exports = Assistant;
