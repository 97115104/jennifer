'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../../config');

const execFileAsync = promisify(execFile);

function getSettings() {
  return require('../../core/Settings').getInstance();
}

const VOICES_DIR = path.join(__dirname, '../../../data/voices');

function sanitizeVoiceName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function cleanAssistantName(name) {
  const cleaned = String(name || '')
    .replace(/[^a-zA-Z0-9 _'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return cleaned || 'Jennifer';
}

function listVoices() {
  if (!fs.existsSync(VOICES_DIR)) return [];
  return fs.readdirSync(VOICES_DIR)
    .filter(f => f.endsWith('.wav'))
    .map(f => ({ name: f.replace('.wav', '') }));
}

function createSettingsRouter() {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.voiceUploadMaxBytes },
  });

  if (!fs.existsSync(VOICES_DIR)) fs.mkdirSync(VOICES_DIR, { recursive: true });

  // GET /api/settings/google/validate — check which Google scopes are active in the stored token
  router.get('/google/validate', async (req, res) => {
    const { makeGoogleClient } = require('../../tools/_googleAuth');
    const client = makeGoogleClient();
    if (typeof client === 'string') return res.json({ connected: false });

    try {
      const tokenResponse = await client.getAccessToken();
      const accessToken = tokenResponse.token;
      if (!accessToken) return res.json({ connected: true, error: 'Token empty — reconnect Google', services: {} });

      const info = await axios.get(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
      );
      const granted = (info.data.scope || '').split(' ');

      res.json({
        connected: true,
        services: {
          gmail:    granted.includes('https://www.googleapis.com/auth/gmail.send'),
          calendar: granted.includes('https://www.googleapis.com/auth/calendar.events'),
          docs:     granted.includes('https://www.googleapis.com/auth/documents'),
          sheets:   granted.includes('https://www.googleapis.com/auth/spreadsheets'),
          drive:    granted.includes('https://www.googleapis.com/auth/drive.file'),
        },
      });
    } catch (err) {
      console.error('[settings/google/validate]', err.message);
      res.json({ connected: true, error: err.message, services: {} });
    }
  });

  // GET /api/settings — current settings (secrets masked)
  router.get('/', (req, res) => {
    const s = getSettings().getAll();
    const inf = s.inference || {};
    res.json({
      app:    s.app,
      tts:    s.tts,
      google: { connected: s.google.connected, email: s.google.email, name: s.google.name },
      github: { connected: s.github.connected, username: s.github.username, name: s.github.name },
      voices: listVoices(),
      inference: {
        provider:           inf.provider || 'openai-compatible',
        apiUrl:             inf.apiUrl   || '',
        model:              inf.model    || '',
        hasApiKey:          !!(inf.apiKey),
        hasAnthropicKey:    !!(inf.anthropicApiKey),
        hasGeminiKey:       !!(inf.geminiApiKey),
      },
    });
  });

  // POST /api/settings/inference — save AI provider config
  router.post('/inference', (req, res) => {
    const { provider, apiUrl, apiKey, model, anthropicApiKey, geminiApiKey } = req.body || {};
    const MASK = '***';
    const patch = {
      provider: ['openai-compatible', 'anthropic', 'gemini'].includes(provider) ? provider : 'openai-compatible',
      model:    String(model || '').trim(),
    };
    if (apiUrl !== undefined)          patch.apiUrl          = String(apiUrl).trim();
    if (apiKey !== undefined && apiKey !== MASK)          patch.apiKey          = String(apiKey).trim();
    if (anthropicApiKey !== undefined && anthropicApiKey !== MASK) patch.anthropicApiKey = String(anthropicApiKey).trim();
    if (geminiApiKey    !== undefined && geminiApiKey    !== MASK) patch.geminiApiKey    = String(geminiApiKey).trim();

    getSettings().set('inference', patch);
    res.json({ ok: true });
  });

  // POST /api/settings/app — update assistant display name and wake word
  router.post('/app', (req, res) => {
    const name = cleanAssistantName(req.body.name);
    getSettings().set('app', { name });
    res.json({ ok: true, app: { name } });
  });

  // GET /api/settings/voices — list voice samples
  router.get('/voices', (req, res) => {
    const activeVoice = getSettings().get('tts').activeVoice;
    const voices = listVoices().map(v => ({
      ...v,
      active: activeVoice === path.join(VOICES_DIR, `${v.name}.wav`),
    }));
    res.json({ voices, activeVoice });
  });

  // POST /api/settings/voices/upload — upload + convert voice sample
  router.post('/voices/upload', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const rawName = req.body.name || `voice_${Date.now()}`;
    const name = sanitizeVoiceName(rawName) || `voice_${Date.now()}`;
    const tmpPath = path.join(os.tmpdir(), `voice_upload_${Date.now()}`);
    const outPath = path.join(VOICES_DIR, `${name}.wav`);

    fs.writeFileSync(tmpPath, req.file.buffer);
    console.log(`[settings/voices] Converting upload → ${outPath} (${(req.file.size / 1024).toFixed(0)}KB)`);

    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', tmpPath,
        '-ar', '22050',
        '-ac', '1',
        '-acodec', 'pcm_s16le',
        outPath,
      ]);
      console.log(`[settings/voices] Saved: ${outPath}`);
      res.json({ ok: true, name });
    } catch (err) {
      console.error('[settings/voices] ffmpeg error:', err.message);
      res.status(500).json({ error: 'Audio conversion failed: ' + err.message });
    } finally {
      fs.unlink(tmpPath, () => {});
    }
  });

  // POST /api/settings/voices/active — set active voice
  router.post('/voices/active', (req, res) => {
    const name = sanitizeVoiceName(req.body.name);
    if (!name) {
      getSettings().set('tts', { activeVoice: null });
      return res.json({ ok: true, activeVoice: null });
    }
    const voicePath = path.join(VOICES_DIR, `${name}.wav`);
    if (!fs.existsSync(voicePath)) return res.status(404).json({ error: 'Voice not found' });
    getSettings().set('tts', { activeVoice: voicePath });
    console.log(`[settings/voices] Active voice set to: ${voicePath}`);
    res.json({ ok: true, activeVoice: voicePath });
  });

  // GET /api/settings/voices/:name/download — download the stored WAV source
  router.get('/voices/:name/download', (req, res) => {
    const name = sanitizeVoiceName(req.params.name);
    const voicePath = path.join(VOICES_DIR, `${name}.wav`);
    if (!name || !fs.existsSync(voicePath)) return res.status(404).json({ error: 'Voice not found' });

    res.download(voicePath, `${name}.wav`);
  });

  // DELETE /api/settings/voices/:name — delete a voice sample
  router.delete('/voices/:name', (req, res) => {
    const name = sanitizeVoiceName(req.params.name);
    const voicePath = path.join(VOICES_DIR, `${name}.wav`);
    if (!fs.existsSync(voicePath)) return res.status(404).json({ error: 'Voice not found' });

    fs.unlinkSync(voicePath);
    const settings = getSettings();
    if (settings.get('tts').activeVoice === voicePath) {
      settings.set('tts', { activeVoice: null });
    }
    console.log(`[settings/voices] Deleted: ${voicePath}`);
    res.json({ ok: true });
  });

  return router;
}

module.exports = createSettingsRouter;
