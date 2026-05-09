'use strict';

const axios = require('axios');
const fs = require('fs');
const TTSProvider = require('./TTSProvider');
const configDefaults = require('../config');

// Integrates with the embedded XTTS v2 server at tts/server.py.
// API: POST /api/tts { text, voice: "data:audio/wav;base64,...", language, speed }
class CoquiTTSProvider extends TTSProvider {
  constructor(config = {}) {
    super(config);
    this.serverUrl = config.coquiUrl || 'http://localhost:5123';
    this.speakerWav = config.coquiSpeakerWav || null;
    this.timeoutMs = config.ttsTimeoutMs ?? configDefaults.ttsTimeoutMs;
  }

  async initialize() {
    const res = await axios.get(`${this.serverUrl}/api/health`, { timeout: 5000 });
    if (!res.data.model_loaded) throw new Error('XTTS model not loaded yet');
    console.log('[coqui] Server ready at', this.serverUrl, '| device:', res.data.device);
  }

  async synthesize(text, outputPath) {
    // Prefer voice set in Settings over the env var default
    let speakerWav = this.speakerWav;
    try {
      const active = require('../core/Settings').getInstance().get('tts').activeVoice;
      if (active) speakerWav = active;
    } catch {}

    if (!speakerWav || !fs.existsSync(speakerWav)) {
      console.warn('[coqui] No speaker WAV found — falling back to system TTS');
      const SystemTTS = require('./SystemTTSProvider');
      return new SystemTTS().synthesize(text, outputPath);
    }

    // Encode the WAV file as a base64 data URL (what the XTTS server expects)
    const wavData = fs.readFileSync(speakerWav);
    const ext = speakerWav.split('.').pop().toLowerCase();
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/wav';
    const voiceDataUrl = `data:${mime};base64,${wavData.toString('base64')}`;

    console.log(`[coqui] Synthesising ${text.length} chars using ${speakerWav.split('/').pop()}`);
    const t0 = Date.now();

    const response = await axios.post(`${this.serverUrl}/api/tts`, {
      text,
      voice: voiceDataUrl,
      language: 'en',
      speed: 1.0,
    }, {
      responseType: 'arraybuffer',
      timeout: this.timeoutMs, // 0 disables Axios timeout for long cloned-speech generations.
    });

    // Server returns MP3 directly
    fs.writeFileSync(outputPath, Buffer.from(response.data));
    console.log(`[coqui] Done in ${Date.now() - t0}ms → ${outputPath}`);
    return outputPath;
  }
}

module.exports = CoquiTTSProvider;
