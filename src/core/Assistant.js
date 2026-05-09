'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const Conversation = require('./Conversation');
const InferenceClient = require('../inference/InferenceClient');

const SYSTEM_PROMPT = `You are Jennifer, a conversational AI voice assistant. Your responses will be spoken aloud, so follow these rules strictly:
- Write responses as natural spoken sentences — no markdown, no bullet points, no headers, no asterisks, no code blocks
- Be concise. A one or two sentence answer is usually best unless the user explicitly asks for details
- When you are about to use a tool, say what you are doing in one short sentence first
- For factual questions, give a direct answer
- Maintain context across the conversation

TOOL USE RULES — follow these exactly:
- When asked to read, fetch, summarize, or get content from a specific website or URL, you MUST call fetch_url. Never paraphrase from memory — always fetch the actual page.
- When asked to "read aloud" or "read to me", fetch the URL and read the full text content in your response.
- When creating files, websites, or running system tasks, use execute_shell and write_file.
- When asked to send email, use send_email.
- Chain tools when needed: fetch a blog homepage to find the latest post URL, then fetch that URL for full content.`;

class Assistant extends EventEmitter {
  constructor({ sttProvider, ttsProvider, toolRegistry }) {
    super();
    this.stt = sttProvider;
    this.tts = ttsProvider;
    this.tools = toolRegistry;
    this.inference = new InferenceClient(toolRegistry);
    this.conversation = new Conversation(SYSTEM_PROMPT);
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
      this.conversation.getMessages(),
      { onStatus: (event) => this.emit('tool_event', event) }
    );
    console.log(`[assistant] Inference complete in ${Date.now() - t0}ms`);

    this.conversation.addAssistant(responseText);
    this.emit('response', { text: responseText });
    this.emit('status', { state: 'speaking', message: 'Speaking...' });

    const audioPath = path.join(os.tmpdir(), `jennifer_out_${uuidv4()}.mp3`);
    console.log(`[assistant] Synthesizing TTS → ${audioPath}`);
    const t1 = Date.now();
    await this.tts.synthesize(responseText, audioPath);
    console.log(`[assistant] TTS done in ${Date.now() - t1}ms`);

    return { transcript: text, response: responseText, audioPath };
  }

  resetConversation() {
    this.conversation.reset(true);
    this.emit('status', { state: 'idle', message: 'Conversation reset' });
  }
}

module.exports = Assistant;
