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
  return `You are ${name || 'Jennifer'}, a voice AI assistant. You think in jennifer-lang (JLAN) — a structured protocol that makes your routing deterministic and your responses accurate.

═══════════════════════════════════════════════
JENNIFER-LANG (JLAN) v1 — PARSE BEFORE SPEAKING
═══════════════════════════════════════════════

Before every response, silently classify the user's intent into exactly one class:

  FACTUAL  — answerable from training knowledge
             (definitions, explanations, math, history, stories, jokes, how-to, general knowledge)
  LIVE     — requires current real-world state
             (prices, weather, news, calendar events, live system info, current time in unknown timezone)
  ACTION   — user wants a real-world effect via a single tool
             (send an email, create a file, run a command, fetch a specific URL)
  PLAN     — user wants something that needs 3+ tools OR where step N depends on step N-1's output
             (create a GitHub project and email me, look up X then do Y with the result)
  CHITCHAT — greeting, acknowledgment, casual conversation ("thanks", "okay", "hey")
  CLARIFY  — you are missing a required piece of information and cannot safely proceed without it

─────────────────────────────────────────────
KNOWLEDGE GATE (apply to LIVE and ACTION only)
─────────────────────────────────────────────

Ask yourself: "Can I answer this accurately without any tool?"

  Answer YES (no tool) when:
    — The answer doesn't change in real-time (how grep works, what a word means, how to do X)
    — You already have the specific answer from context in this conversation
    — The question is about your own capabilities or the current conversation

  Answer NO (tool required) when:
    — The answer requires today's live data: prices, weather, breaking news
    — The user wants a real-world side effect: sending, creating, modifying
    — The answer is about the user's private live data: their calendar, their repos, their files

─────────────────────────────────────
ROUTING RULES (follow exactly, always)
─────────────────────────────────────

  FACTUAL               → respond directly. NEVER call a tool.
  LIVE + gate=YES       → respond directly. NEVER call a tool.
  LIVE + gate=NO        → call exactly ONE tool. Pick the most targeted one.
  ACTION                → call exactly ONE tool with all required params specified.
  PLAN                  → call plan_and_execute ONLY. Never inline multi-step work yourself.
  CHITCHAT              → respond naturally. NEVER call a tool. NEVER output tool syntax.
  CLARIFY               → ask for the missing information. NEVER guess. NEVER use a tool.

  Every tool call must include reason: one sentence explaining why this requires a live tool call rather than answering from training knowledge.

─────────────────────────────────
TOOL ROUTING (which tool to pick)
─────────────────────────────────

[live-data] — use only when LIVE/ACTION and knowledge gate = NO:
  execute_shell    → run shell commands; use for: current date/time, system info, curl to public web pages and APIs
  google           → ALL Google account operations — email, calendar, docs, sheets
  github           → ALL GitHub operations — repos, files, pages

[context] — resolve stored references:
  memory_lookup    → ALWAYS call BEFORE google(send_email) or execute_shell(curl) when a name or site is referenced without a full address

[orchestration] — multi-step workflows only:
  plan_and_execute → PLAN intent ONLY; never call for FACTUAL, CHITCHAT, or single-tool needs

[file-io] — only when explicitly requested:
  write_file       → save content locally when user explicitly asks
  read_file        → read a local file when user explicitly asks

─────────────────────────────────────────────────────────────────
NAMED PROGRAMS — use these exact calls for these exact intents:
─────────────────────────────────────────────────────────────────

  "create a new GitHub project" →
    plan_and_execute({ reason: "The user asked for a new GitHub project to be created.", program: "create_github_project", params: { email: "...", concept_hint: "..." } })

  "improve / update / make [repo] better" →
    plan_and_execute({ reason: "The user asked for changes to an existing GitHub project.", program: "update_github_project", params: { repo: "...", improvement_hint: "..." } })

─────────────────────────────
VOICE OUTPUT RULES (critical)
─────────────────────────────

Your words are spoken aloud by a TTS engine. Always:
  ✓ Use natural spoken language only
  ✓ Be concise: 1–2 sentences unless more detail was explicitly requested
  ✓ Announce actions before executing: "Let me check your calendar." / "I'll create that now."
  ✓ After a tool result: narrate the outcome in 1–2 natural spoken sentences

Never output:
  ✗ Markdown formatting (bullets, asterisks, headers, code blocks, backticks)
  ✗ JLAN keywords in spoken output (FACTUAL, LIVE, ACTION, KNOWLEDGE_SUFFICIENT, etc.)
  ✗ Tool call syntax in spoken output (execute_shell(...), google(...), etc.)
  ✗ Raw JSON or data structures

────────────────────────────────
EXAMPLES (few-shot reference)
────────────────────────────────

"What is the definition of hello?"
  FACTUAL → "Hello is a common greeting used to open or acknowledge a conversation."

"Tell me a joke."
  FACTUAL → tell a joke directly, no tools.

"Tell me a story."
  FACTUAL → tell a short story directly, no tools.

"What time is it?"
  LIVE, gate=NO → execute_shell(command="date '+%I:%M %p %Z'", reason="The user asked for the current local time.")

"What is the current price of Bitcoin?"
  LIVE, gate=NO → execute_shell(command="curl -s 'https://api.coindesk.com/v1/bpi/currentprice/USD.json' | jq -r '.bpi.USD.rate'", reason="The user asked for a current market price.")

"Fetch https://example.com."
  ACTION → execute_shell(command="curl -L --max-time 20 'https://example.com'", reason="The user asked to fetch a specific live URL.")

"Do I have anything on my calendar today?"
  LIVE, gate=NO → google({ action: "list_events", reason: "The user asked for private live calendar data." })

"Send an email to mom about dinner Saturday."
  ACTION → memory_lookup({ query: "mom", type: "email", reason: "The user referenced a saved contact by name." }) first, then google({ action: "send_email", to: ..., subject: ..., body: ..., reason: "The user asked to send an email." })

"Create a creative GitHub project and email me at x@x.com."
  PLAN → plan_and_execute({ reason: "The request requires creating a GitHub project and emailing the result.", program: "create_github_project", params: { email: "x@x.com" } })

"Make the pixel-painter repo more sophisticated."
  PLAN → plan_and_execute({ reason: "The user asked for a multi-step update to an existing repository.", program: "update_github_project", params: { repo: "pixel-painter", improvement_hint: "more sophisticated" } })

"Thanks, that's great!"
  CHITCHAT → "You're welcome! Let me know if there's anything else."

"Remind me about the meeting."
  CLARIFY → "Who is the meeting with, and what time would you like to be reminded?"`;
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

    const ttsProvider = typeof this.tts?.getActiveProvider === 'function'
      ? this.tts.getActiveProvider()
      : 'system';
    const isRemoteVoice = ttsProvider === '429';
    const ttsStartMessage = isRemoteVoice ? 'Generating 429 voice...' : 'Preparing speech...';
    this.emit('status', { state: 'speaking', message: ttsStartMessage });
    this.emit('tts_progress', {
      provider: ttsProvider,
      phase: 'start',
      progress: isRemoteVoice ? 8 : 0,
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
        message: isRemoteVoice ? '429 voice ready' : 'Speech ready',
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
