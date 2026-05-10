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

async function _fetchModelsForProvider(provider, inf) {
  const norm = provider === 'openai-compatible' ? 'custom' : provider;

  if (norm === '429-inference') {
    const key = inf.api429Key || inf.apiKey || '';
    if (!key) return { models: [], error: 'API key not configured — save your key first' };
    try {
      const res = await axios.get('https://api.429inference.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` }, timeout: 8000,
      });
      return { models: (res.data?.data || []).map(m => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id)) };
    } catch (err) {
      return { models: [], error: err.response?.data?.error?.message || err.message };
    }
  }

  if (norm === 'chatgpt') {
    const key = inf.chatgptApiKey || '';
    if (!key) return { models: [], error: 'ChatGPT API key not configured — save your key first' };
    try {
      const res = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` }, timeout: 8000,
      });
      const models = (res.data?.data || [])
        .filter(m => /^(gpt-|o\d)/.test(m.id))
        .map(m => ({ id: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models };
    } catch (err) {
      return { models: [], error: err.response?.data?.error?.message || err.message };
    }
  }

  if (norm === 'anthropic') {
    const key = inf.anthropicApiKey || '';
    if (!key) return { models: [], error: 'Anthropic API key not configured — save your key first' };
    try {
      const res = await axios.get('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, timeout: 8000,
      });
      return { models: (res.data?.data || []).map(m => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id)) };
    } catch (err) {
      return { models: [], error: err.response?.data?.error?.message || err.message };
    }
  }

  if (norm === 'gemini') {
    const key = inf.geminiApiKey || '';
    if (!key) return { models: [], error: 'Gemini API key not configured — save your key first' };
    try {
      const res = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        { timeout: 8000 }
      );
      const models = (res.data?.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({ id: m.name.replace('models/', '') }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models };
    } catch (err) {
      return { models: [], error: err.response?.data?.error?.message || err.message };
    }
  }

  if (norm === 'custom') {
    const apiUrl = inf.apiUrl || '';
    const key = inf.apiKey || '';
    if (!apiUrl) return { models: [], error: 'API URL not configured' };
    try {
      const res = await axios.get(`${apiUrl.replace(/\/$/, '')}/v1/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {}, timeout: 8000,
      });
      return { models: (res.data?.data || []).map(m => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id)) };
    } catch (err) {
      return { models: [], error: err.message };
    }
  }

  return { models: [], error: 'Unknown provider' };
}

function createSettingsRouter(ttsProvider) {
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

  // GET /api/settings/inference/models — fetch available models for a provider
  router.get('/inference/models', async (req, res) => {
    const provider = req.query.provider || getSettings().get('inference')?.provider || '429-inference';
    const inf = getSettings().get('inference') || {};
    const result = await _fetchModelsForProvider(provider, inf);
    res.json(result);
  });

  // GET /api/settings — current settings (secrets masked)
  router.get('/', (req, res) => {
    const s = getSettings().getAll();
    const inf = s.inference || {};
    const raw = inf.provider || '429-inference';
    let provider = raw === 'openai-compatible' ? 'custom' : raw;
    // Auto-detect legacy 429 setup: openai-compatible + 429inference.com URL → show as 429-inference
    if (provider === 'custom' && (inf.apiUrl || '').includes('429inference.com')) {
      provider = '429-inference';
    }
    res.json({
      app:    s.app,
      tts: {
        provider:      s.tts.provider,
        activeVoice:   s.tts.activeVoice,
        speed:         s.tts.speed,
        autoSpeak:     s.tts.autoSpeak,
        hasApiKey429:  !!(s.tts.apiKey429),
        hasVoiceRef429: !!(s.tts.voiceRef429 && fs.existsSync(s.tts.voiceRef429)),
        voiceRef429Label: s.tts.voiceRef429 ? path.basename(s.tts.voiceRef429) : null,
      },
      google: { connected: s.google.connected, email: s.google.email, name: s.google.name },
      github: { connected: s.github.connected, username: s.github.username, name: s.github.name },
      voices: listVoices(),
      inference: {
        provider,
        apiUrl:          inf.apiUrl  || '',
        model:           inf.model   || '',
        hasApi429Key:    !!(inf.api429Key || (provider === '429-inference' && inf.apiKey)),
        hasChatgptKey:   !!(inf.chatgptApiKey),
        hasAnthropicKey: !!(inf.anthropicApiKey),
        hasGeminiKey:    !!(inf.geminiApiKey),
        hasApiKey:       !!(inf.apiKey),
      },
    });
  });

  // POST /api/settings/inference — save AI provider config
  router.post('/inference', (req, res) => {
    const { provider, apiUrl, apiKey, api429Key, chatgptApiKey, model, anthropicApiKey, geminiApiKey } = req.body || {};
    const VALID = ['429-inference', 'chatgpt', 'anthropic', 'gemini', 'custom', 'openai-compatible'];
    const MASK = '***';
    const patch = {
      provider: VALID.includes(provider) ? provider : '429-inference',
      model:    String(model || '').trim(),
    };
    if (apiUrl          !== undefined)             patch.apiUrl          = String(apiUrl).trim();
    if (apiKey          !== undefined && apiKey          !== MASK) patch.apiKey          = String(apiKey).trim();
    if (api429Key       !== undefined && api429Key       !== MASK) patch.api429Key       = String(api429Key).trim();
    if (chatgptApiKey   !== undefined && chatgptApiKey   !== MASK) patch.chatgptApiKey   = String(chatgptApiKey).trim();
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

  // POST /api/settings/voices/ref429 — set 429 reference voice by saved name
  router.post('/voices/ref429', (req, res) => {
    const name = sanitizeVoiceName(req.body.name);
    if (!name) {
      getSettings().set('tts', { voiceRef429: '' });
      return res.json({ ok: true, voiceRef429: null });
    }
    const voicePath = path.join(VOICES_DIR, `${name}.wav`);
    if (!fs.existsSync(voicePath)) return res.status(404).json({ error: 'Voice not found' });
    getSettings().set('tts', { voiceRef429: voicePath });
    console.log(`[settings/voices] ref429 set to: ${voicePath}`);
    res.json({ ok: true, voiceRef429: voicePath });
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

  // POST /api/settings/tts — save TTS settings
  router.post('/tts', (req, res) => {
    const VALID_PROVIDERS = ['system', 'local', '429'];
    const MASK = '***';
    const { provider, apiKey429, voiceRef429, speed, autoSpeak } = req.body || {};

    const patch = {};
    if (provider !== undefined && VALID_PROVIDERS.includes(provider)) patch.provider = provider;
    if (apiKey429 !== undefined && apiKey429 !== MASK) patch.apiKey429 = String(apiKey429).trim();
    if (voiceRef429 !== undefined) patch.voiceRef429 = String(voiceRef429).trim();
    if (speed !== undefined) patch.speed = Math.min(2.0, Math.max(0.5, parseFloat(speed) || 1.0));
    if (autoSpeak !== undefined) patch.autoSpeak = Boolean(autoSpeak);

    getSettings().set('tts', patch);
    res.json({ ok: true });
  });

  // GET /api/settings/tts/health — check TTS provider connectivity
  router.get('/tts/health', async (req, res) => {
    const tts = getSettings().get('tts') || {};
    const provider = tts.provider || 'system';

    if (provider === 'system') {
      const { execFile } = require('child_process');
      const bin = process.platform === 'darwin' ? 'say' : 'espeak-ng';
      execFile(bin, ['--version'], (err) => {
        res.json({ ok: !err, provider, detail: err ? `${bin} not found` : `${bin} available` });
      });
      return;
    }

    if (provider === 'local') {
      try {
        const r = await axios.get('http://localhost:5123/api/health', { timeout: 4000 });
        res.json({ ok: true, provider, detail: `XTTS ready, device: ${r.data.device || 'unknown'}` });
      } catch (err) {
        res.json({ ok: false, provider, detail: err.message });
      }
      return;
    }

    if (provider === '429') {
      if (!tts.apiKey429) {
        return res.json({ ok: false, provider, detail: 'API key not configured' });
      }
      try {
        const r = await axios.get('https://api.429inference.com/v1/models', {
          headers: { Authorization: `Bearer ${tts.apiKey429}` },
          timeout: 6000,
        });
        const hasTTS = (r.data?.data || []).some(m => m.id === 'chatterbox-turbo' || (m.id || '').startsWith('tts'));
        res.json({ ok: true, provider, detail: hasTTS ? 'TTS model available' : 'Connected (TTS model not listed yet)' });
      } catch (err) {
        res.json({ ok: false, provider, detail: err.response?.data?.error?.message || err.message });
      }
      return;
    }

    res.json({ ok: false, provider, detail: 'Unknown provider' });
  });

  // POST /api/settings/tts/test — synthesize "This is a test." with specified or saved provider
  router.post('/tts/test', async (req, res) => {
    if (!ttsProvider) return res.status(503).json({ error: 'TTS provider not available' });

    // Use the provider the UI currently shows, not what's saved (allows testing before saving)
    const reqProvider = req.body?.provider;
    const impl = reqProvider && ttsProvider._providers
      ? (ttsProvider._providers[reqProvider] || ttsProvider._providers.system)
      : ttsProvider;

    const tmpPath = path.join(os.tmpdir(), `tts_test_${Date.now()}.mp3`);
    try {
      await impl.synthesize('This is a test.', tmpPath);
      const audio = fs.readFileSync(tmpPath).toString('base64');
      res.json({ ok: true, audio, mimeType: 'audio/mpeg' });
    } catch (err) {
      console.error('[settings/tts/test]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      fs.unlink(tmpPath, () => {});
    }
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
