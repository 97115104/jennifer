'use strict';

const http = require('http');
const config = require('../config');
const { createApp, attachWebSocket } = require('./app');

const WhisperProvider = require('../stt/WhisperProvider');
const SystemTTSProvider = require('../tts/SystemTTSProvider');
const Remote429TTSProvider = require('../tts/Remote429TTSProvider');
const DynamicTTSProvider = require('../tts/DynamicTTSProvider');
const { resolve429VoicePath } = require('../tts/default429Voice');
const ToolRegistry = require('../tools/ToolRegistry');
const WebFetchTool = require('../tools/WebFetchTool');
const ShellTool = require('../tools/ShellTool');
const MemoryTool = require('../tools/MemoryTool');
const ReadFileTool = require('../tools/ReadFileTool');
const WriteFileTool = require('../tools/WriteFileTool');
const GithubTool = require('../tools/GithubTool');
const GoogleTool = require('../tools/GoogleTool');
const DeslopTool = require('../tools/DeslopTool');
const DehallucinateTool = require('../tools/DehallucinateTool');
const PlannerTool = require('../tools/PlannerTool');
const Assistant = require('../core/Assistant');
const Settings = require('../core/Settings');

async function main() {
  console.log('\n🎙  Jennifer starting up...\n');

  // Init settings singleton (loads data/settings.json)
  const settings = Settings.getInstance();

  const stt = new WhisperProvider({ whisperModel: config.whisperModel });

  const systemTTS = new SystemTTSProvider();
  const remote429TTS = new Remote429TTSProvider();

  const tts = new DynamicTTSProvider({
    system: systemTTS,
    remote429: remote429TTS,
  });

  // Seed TTS settings from env on first run / when values are missing.
  const savedTts = settings.get('tts');
  const ttsPatch = {};
  if (!savedTts?.provider || !['system', '429'].includes(savedTts.provider)) {
    ttsPatch.provider = config.ttsProvider;
  }
  if (config.apiVoiceKey429 && !savedTts?.apiKey429) {
    ttsPatch.apiKey429 = config.apiVoiceKey429;
  }
  const effectiveProvider = ttsPatch.provider || savedTts?.provider || config.ttsProvider;
  const resolvedVoiceRef429 = resolve429VoicePath(savedTts?.voiceRef429);
  if (effectiveProvider === '429' && resolvedVoiceRef429 && resolvedVoiceRef429 !== savedTts?.voiceRef429) {
    ttsPatch.voiceRef429 = resolvedVoiceRef429;
  }
  if (Object.keys(ttsPatch).length) settings.set('tts', ttsPatch);
  console.log(`[boot] Active TTS provider: ${settings.get('tts').provider}`);

  const tools = new ToolRegistry();
  tools.register(WebFetchTool);
  tools.register(MemoryTool);
  tools.register(ShellTool);
  tools.register(ReadFileTool);
  tools.register(WriteFileTool);
  tools.register(GithubTool);
  tools.register(GoogleTool);
  tools.register(DeslopTool);
  tools.register(DehallucinateTool);
  tools.register(PlannerTool);

  const assistant = new Assistant({ sttProvider: stt, ttsProvider: tts, toolRegistry: tools });

  // Inject inference client + named tool objects into PlannerTool
  // (breaks circular dep — can't inject before Assistant creates InferenceClient)
  PlannerTool.inject(assistant.inference, {
    github: GithubTool,
    google: GoogleTool,
    fetchUrl: WebFetchTool,
  });
  await assistant.initialize();

  const app = createApp(assistant);
  const server = http.createServer(app);
  attachWebSocket(server, assistant);

  server.listen(config.port, () => {
    console.log(`\n✅  Jennifer is running at http://localhost:${config.port}`);
    console.log(`   Settings:  http://localhost:${config.port}/settings`);
    console.log('   Open the URL in Chrome and click Start\n');
  });
}

main().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
