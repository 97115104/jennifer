'use strict';

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const createAuthRouter = require('./routes/auth');
const createSettingsRouter = require('./routes/settings');

function createApp(assistant) {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.queryAudioMaxBytes },
  });

  app.use(cors());
  app.use(express.json());
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 15 * 60 * 1000 },
  }));

  // Serve Silero VAD web bundle + ONNX runtime files
  const vadDist = path.join(__dirname, '../../node_modules/@ricky0123/vad-web/dist');
  if (fs.existsSync(vadDist)) {
    app.use('/vad', express.static(vadDist));
    console.log('[app] Serving VAD bundle at /vad/');
  } else {
    console.warn('[app] @ricky0123/vad-web not found — run npm install');
  }
  // Also serve onnxruntime-web WASM files at /vad/ (needed by vad bundle)
  const ortDist = path.join(__dirname, '../../node_modules/onnxruntime-web/dist');
  if (fs.existsSync(ortDist)) {
    app.use('/vad', express.static(ortDist));
  }

  // Static files
  app.use(express.static(path.join(__dirname, '../../public')));

  // Auth OAuth routes
  app.use('/auth', createAuthRouter(config));

  // Settings API
  app.use('/api/settings', createSettingsRouter());

  // Settings page
  app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/settings.html'));
  });

  app.get('/api/health', (req, res) => {
    const activeTTSProvider = assistant.tts?.constructor?.name === 'CoquiTTSProvider' ? 'coqui' : 'system';

    res.json({
      status: 'ok',
      version: '1.0.0',
      tts: {
        configuredProvider: config.ttsProvider,
        activeProvider: activeTTSProvider,
      },
      tools: assistant.tools ? assistant.tools.list() : [],
    });
  });

  // Live 429 API connectivity check
  app.get('/api/test', async (req, res) => {
    console.log('[test] Testing 429 API connection...');
    const t0 = Date.now();
    try {
      const response = await axios.post(
        `${config.apiBaseUrl}/v1/chat/completions`,
        {
          model: config.apiModel,
          messages: [{ role: 'user', content: 'Reply with exactly: API OK' }],
          max_tokens: 256,
          temperature: 0,
        },
        {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const text = response.data.choices[0].message.content;
      const worker = response.headers['x-429-worker-name'] || 'unknown';
      const tps = response.headers['x-429-tps'] || '?';
      console.log(`[test] ✅ API OK in ${Date.now() - t0}ms | worker=${worker} | tps=${tps} | reply="${text}"`);
      res.json({ status: 'ok', reply: text, worker, tps, ms: Date.now() - t0, model: config.apiModel });
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data || err.message;
      console.error(`[test] ✗ API test failed (HTTP ${status}):`, detail);
      res.status(502).json({ status: 'error', httpStatus: status, error: detail });
    }
  });

  // RPi / programmatic: submit audio file
  app.post('/api/query/audio', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    try {
      const result = await assistant.processAudio(req.file.buffer, req.file.mimetype);
      const audioData = fs.existsSync(result.audioPath)
        ? fs.readFileSync(result.audioPath).toString('base64')
        : null;
      if (result.audioPath) fs.unlink(result.audioPath, () => {});
      res.json({ transcript: result.transcript, response: result.response, audio: audioData, mimeType: 'audio/mpeg' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // RPi / programmatic: submit text
  app.post('/api/query/text', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });
    try {
      const result = await assistant.processText(text);
      const audioData = fs.existsSync(result.audioPath)
        ? fs.readFileSync(result.audioPath).toString('base64')
        : null;
      if (result.audioPath) fs.unlink(result.audioPath, () => {});
      res.json({ transcript: result.transcript, response: result.response, audio: audioData, mimeType: 'audio/mpeg' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve generated TTS audio by filename (safe basename only)
  app.get('/api/audio/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(os.tmpdir(), safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(filePath);
  });

  return app;
}

function attachWebSocket(server, assistant) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', ws => {
    const id = uuidv4().slice(0, 8);
    console.log(`[ws] Client connected: ${id}`);

    const send = data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };

    const handlers = {
      status: e => send({ type: 'status', ...e }),
      transcript: e => send({ type: 'transcript', ...e }),
      response: e => send({ type: 'response', ...e }),
      tts_progress: e => send({ type: 'tts_progress', ...e }),
      tool_event: e => send({ type: e.type, ...e }),
    };

    for (const [event, fn] of Object.entries(handlers)) assistant.on(event, fn);

    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'audio') {
        const byteLen = Math.round((msg.data?.length || 0) * 0.75);
        console.log(`[ws:${id}] ← audio received: ~${(byteLen / 1024).toFixed(1)}KB (${msg.mimeType || 'audio/webm'})`);
        try {
          const buf = Buffer.from(msg.data, 'base64');
          const result = await assistant.processAudio(buf, msg.mimeType || 'audio/webm');
          if (result.audioPath && fs.existsSync(result.audioPath)) {
            const audioData = fs.readFileSync(result.audioPath).toString('base64');
            const audioSize = (audioData.length * 0.75 / 1024).toFixed(1);
            fs.unlink(result.audioPath, () => {});
            console.log(`[ws:${id}] → sending audio response: ~${audioSize}KB`);
            send({ type: 'audio', data: audioData, mimeType: 'audio/mpeg' });
          }
        } catch (err) {
          console.error(`[ws:${id}] ✗ processAudio error:`, err.message);
          send({ type: 'error', message: err.message });
        }
      }

      if (msg.type === 'text') {
        console.log(`[ws:${id}] ← text: "${msg.content}"`);
        try {
          const result = await assistant.processText(msg.content);
          if (result.audioPath && fs.existsSync(result.audioPath)) {
            const audioData = fs.readFileSync(result.audioPath).toString('base64');
            const audioSize = (audioData.length * 0.75 / 1024).toFixed(1);
            fs.unlink(result.audioPath, () => {});
            console.log(`[ws:${id}] → sending audio response: ~${audioSize}KB`);
            send({ type: 'audio', data: audioData, mimeType: 'audio/mpeg' });
          }
        } catch (err) {
          console.error(`[ws:${id}] ✗ processText error:`, err.message);
          send({ type: 'error', message: err.message });
        }
      }

      if (msg.type === 'reset') {
        console.log(`[ws:${id}] ← reset`);
        assistant.resetConversation();
        send({ type: 'status', state: 'idle', message: 'Conversation reset' });
      }
    });

    ws.on('close', () => {
      console.log(`[ws] Client disconnected: ${id}`);
      for (const [event, fn] of Object.entries(handlers)) assistant.off(event, fn);
    });

    send({ type: 'status', state: 'idle', message: 'Connected to Jennifer' });
  });

  return wss;
}

module.exports = { createApp, attachWebSocket };
