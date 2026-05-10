'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const TTSProvider = require('./TTSProvider');
const { getInstance: getSettings } = require('../core/Settings');
const { DEFAULT_429_VOICE_NAME, resolve429VoicePath } = require('./default429Voice');

const TTS_ENDPOINT = 'https://api.429inference.com/v1/tts/synthesize';

class Remote429TTSProvider extends TTSProvider {
  async synthesize(text, outputPath) {
    const tts = getSettings().get('tts');
    const { apiKey429, voiceRef429 } = tts || {};
    const voicePath = resolve429VoicePath(voiceRef429);

    if (!apiKey429) throw new Error('429 TTS API key is not configured');
    if (!voicePath) throw new Error(`429 TTS needs a saved voice source. Record or upload one in Settings, then click Use. The default "${DEFAULT_429_VOICE_NAME}" voice is missing.`);

    const voiceBase64 = fs.readFileSync(voicePath).toString('base64');
    const body = JSON.stringify({
      text,
      voice: voiceBase64,
      language: 'en',
      exaggeration: 0.5,
      format: 'mp3',
    });

    await new Promise((resolve, reject) => {
      const url = new URL(TTS_ENDPOINT);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey429}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`429 TTS: HTTP ${res.statusCode}`));
          }
          const out = fs.createWriteStream(outputPath);
          res.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    return outputPath;
  }
}

module.exports = Remote429TTSProvider;
