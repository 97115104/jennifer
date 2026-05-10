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

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')        // fenced code blocks
    .replace(/`[^`]*`/g, '')               // inline code
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
    .replace(/\*([^*]+)\*/g, '$1')         // italic
    .replace(/__([^_]+)__/g, '$1')         // bold underscore
    .replace(/_([^_]+)_/g, '$1')           // italic underscore
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^[\*\-\+]\s+/gm, '')         // unordered list bullets
    .replace(/^\d+\.\s+/gm, '')            // ordered list numbers
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

TOOL ROUTING:
  github  → ALL GitHub ops: create_repo, push_file, get_file, list_repos, get_user, enable_pages
  google  → ALL Google ops — uses the connected Google account automatically, no email/ID needed:
              email    → action: send_email (to, subject, body)
              calendar → action: list_events [NO other params needed] | create_event | get_event | update_event | delete_event
              docs     → action: create_doc | read_doc | update_doc | delete_doc
              sheets   → action: create_sheet | read_sheet | update_sheet | append_to_sheet | clear_sheet
  fetch_url        → fetch web pages
  execute_shell    → run shell commands
  write_file       → save local files
  read_file        → read local files
  memory_lookup    → resolve a saved name/site/variable → call BEFORE google(send_email) or fetch_url
  plan_and_execute → multi-step tasks where 3+ tools are needed, OR any step depends on a previous step's output

NAMED PROGRAMS (use these when the request matches — they run deterministically):
  create_github_project → user wants a NEW repo. Never use this when repo already exists.
    call: plan_and_execute({ program: "create_github_project",
           params: { email: "address@example.com", concept_hint: "optional theme" } })

  update_github_project → user wants to IMPROVE an existing repo ("make it better", "update X",
                          "make it more sophisticated", "add feature Y to X", etc.)
    call: plan_and_execute({ program: "update_github_project",
           params: { repo: "repo-name", improvement_hint: "what to improve", email: "optional" } })

CONCRETE EXAMPLES:
  User: "do I have anything on my calendar?" or "any upcoming events?"
  → google({ action: "list_events" }) — call immediately, no other params needed

  User: "create a creative GitHub project and email me at X"
  → program="create_github_project", params.email="X"

  User: "make the pixel-painter repo more sophisticated"
  → program="update_github_project", params.repo="pixel-painter", params.improvement_hint="more sophisticated"

  The program handles all steps. You narrate the result in 2–3 spoken sentences.

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
      await this.tts.synthesize(stripMarkdown(responseText), audioPath);
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
    const ConversationHistory = require('./ConversationHistory');
    ConversationHistory.save(this.conversation.getMessages());
    this.conversation.reset(true);
    this.emit('status', { state: 'idle', message: 'Conversation reset' });
  }
}

module.exports = Assistant;
