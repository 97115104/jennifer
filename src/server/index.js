'use strict';

const http = require('http');
const config = require('../config');
const { createApp, attachWebSocket } = require('./app');

const WhisperProvider = require('../stt/WhisperProvider');
const SystemTTSProvider = require('../tts/SystemTTSProvider');
const CoquiTTSProvider = require('../tts/CoquiTTSProvider');
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

  let tts;
  if (config.ttsProvider === 'coqui') {
    const coqui = new CoquiTTSProvider({
      coquiUrl: config.coquiUrl,
      coquiSpeakerWav: config.coquiSpeakerWav,
      ttsTimeoutMs: config.ttsTimeoutMs,
    });
    try {
      await coqui.initialize();
      tts = coqui;
      settings.set('tts', { provider: 'coqui' });
      console.log('[boot] Using Coqui XTTS v2 voice');
    } catch {
      console.log('[boot] Coqui unavailable — using system TTS');
      tts = new SystemTTSProvider();
      settings.set('tts', { provider: 'system' });
    }
  } else {
    tts = new SystemTTSProvider();
    settings.set('tts', { provider: 'system' });
    console.log('[boot] Using system TTS');
  }

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
