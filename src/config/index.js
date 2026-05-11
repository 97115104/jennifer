'use strict';

require('dotenv').config();
const os = require('os');

const requestedTTSProvider = process.env.TTS_PROVIDER || 'system';
const ttsProvider = ['system', '429'].includes(requestedTTSProvider)
  ? requestedTTSProvider
  : 'system';

function readIntEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const config = {
  apiKey: process.env['429-API-KEY'],
  apiVoiceKey429: process.env['429-VOICE-API-KEY'] || process.env['429-API-VOICE-KEY'] || process.env['429-API-KEY'] || '',
  apiBaseUrl: process.env.API_BASE_URL || 'https://api.429inference.com',
  apiModel: process.env.API_MODEL || 'dynamic',
  apiMaxTokens: readIntEnv('API_MAX_TOKENS', 8192),
  apiTimeoutMs: readIntEnv('API_TIMEOUT_MS', 0),
  port: parseInt(process.env.PORT || '3000', 10),
  whisperModel: process.env.WHISPER_MODEL || 'Xenova/whisper-base.en',
  ttsProvider,
  ttsTimeoutMs: readIntEnv('TTS_TIMEOUT_MS', 0),
  fetchMaxChars: readIntEnv('FETCH_MAX_CHARS', 50000),
  fetchTimeoutMs: readIntEnv('FETCH_TIMEOUT_MS', 45000),
  queryAudioMaxBytes: readIntEnv('QUERY_AUDIO_MAX_MB', 500) * 1024 * 1024,
  voiceUploadMaxBytes: readIntEnv('VOICE_UPLOAD_MAX_MB', 500) * 1024 * 1024,
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
