'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function getSettings() {
  return require('../../core/Settings').getInstance();
}

const VOICES_DIR = path.join(__dirname, '../../../data/voices');

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
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  if (!fs.existsSync(VOICES_DIR)) fs.mkdirSync(VOICES_DIR, { recursive: true });

  // GET /api/settings — current settings (no secrets)
  router.get('/', (req, res) => {
    const s = getSettings().getAll();
    res.json({
      tts: s.tts,
      google: { connected: s.google.connected, email: s.google.email, name: s.google.name },
      github: { connected: s.github.connected, username: s.github.username, name: s.github.name },
      voices: listVoices(),
    });
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
    const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
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
    const { name } = req.body;
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

  // DELETE /api/settings/voices/:name — delete a voice sample
  router.delete('/voices/:name', (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '_');
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
