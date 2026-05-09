'use strict';

require('dotenv').config();
const os = require('os');

const requestedTTSProvider = process.env.TTS_PROVIDER || 'system';
const ttsProvider = ['system', 'coqui'].includes(requestedTTSProvider)
  ? requestedTTSProvider
  : 'system';

const config = {
  apiKey: process.env['429-API-KEY'],
  apiBaseUrl: process.env.API_BASE_URL || 'https://api.429inference.com',
  apiModel: process.env.API_MODEL || 'gpt-oss',
  port: parseInt(process.env.PORT || '3000', 10),
  whisperModel: process.env.WHISPER_MODEL || 'Xenova/whisper-base.en',
  ttsProvider,
  coquiUrl: process.env.COQUI_URL || 'http://localhost:5123',
  coquiSpeakerWav: process.env.COQUI_SPEAKER_WAV || null,
  email: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  },
  sessionSecret: process.env.SESSION_SECRET || 'jennifer-session-secret',
  tmpDir: process.env.TMP_DIR || os.tmpdir(),
};

if (!config.apiKey) {
  console.warn('[config] WARNING: 429-API-KEY not set in .env');
}

if (requestedTTSProvider !== config.ttsProvider) {
  console.warn(`[config] WARNING: invalid TTS_PROVIDER="${requestedTTSProvider}"; using "system"`);
}

module.exports = config;
