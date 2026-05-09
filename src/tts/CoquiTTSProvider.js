'use strict';

const axios = require('axios');
const fs = require('fs');
const TTSProvider = require('./TTSProvider');

// Integrates with the XTTS v2 (Coqui) voice cloning server.
// Compatible with the myvoice project: https://github.com/97115104/myvoice
// Set TTS_PROVIDER=coqui and COQUI_URL=http://localhost:5123 in .env to enable.
// Optionally set COQUI_SPEAKER_WAV to a voice sample file for cloned voice output.
class CoquiTTSProvider extends TTSProvider {
  constructor(config = {}) {
    super(config);
    this.serverUrl = config.coquiUrl || 'http://localhost:5123';
    this.speakerWav = config.coquiSpeakerWav || null;
  }

  async initialize() {
    await axios.get(`${this.serverUrl}/health`, { timeout: 3000 });
    console.log('[coqui] Server ready at', this.serverUrl);
  }

  async synthesize(text, outputPath) {
    const payload = { text, language: 'en' };
    if (this.speakerWav) payload.speaker_wav = this.speakerWav;

    const response = await axios.post(`${this.serverUrl}/tts`, payload, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    fs.writeFileSync(outputPath, Buffer.from(response.data));
    return outputPath;
  }
}

module.exports = CoquiTTSProvider;
