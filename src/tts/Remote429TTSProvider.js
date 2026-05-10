'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const TTSProvider = require('./TTSProvider');
const { getInstance: getSettings } = require('../core/Settings');
const { DEFAULT_429_VOICE_NAME, resolve429VoicePath } = require('./default429Voice');

const SHORT_TTS_CHAR_LIMIT = 2000;
const DEFAULT_MAX_RETRIES = 3;

function get429BaseUrl() {
  return (process.env.API_BASE_URL || 'https://api.429inference.com').replace(/\/$/, '');
}

function readMaxRetries() {
  const value = parseInt(process.env.TTS_429_MAX_RETRIES || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_RETRIES;
}

function make429ApiError(message, statusCode) {
  const err = new Error(message);
  err.allowSystemFallback = true;
  err.statusCode = statusCode;
  err.retryable = statusCode === 429 || statusCode >= 500;
  return err;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class Remote429TTSProvider extends TTSProvider {
  constructor(config = {}) {
    super(config);
    this._voiceId = null;
    this._voiceIdPath = '';
    this._voiceIdSignature = '';
  }

  async synthesize(text, outputPath) {
    const tts = getSettings().get('tts');
    const { apiKey429, voiceRef429 } = tts || {};
    const voicePath = resolve429VoicePath(voiceRef429);
    const cleanText = String(text || '').trim();

    if (!apiKey429) throw new Error('429 TTS API key is not configured');
    if (!voicePath) {
      throw new Error(
        `429 TTS needs a saved voice source. Record or upload one in Settings, then click Use. ` +
        `The default "${DEFAULT_429_VOICE_NAME}" voice is missing.`
      );
    }
    if (!cleanText) throw new Error('429 TTS needs text to synthesize');

    const voiceId = await this._ensureVoiceUploaded(apiKey429, voicePath);

    if (cleanText.length <= SHORT_TTS_CHAR_LIMIT) {
      return this._synthesizeShortWithRetries(cleanText, outputPath, apiKey429, voiceId);
    }

    return this._synthesizeLong(cleanText, outputPath, apiKey429, voiceId);
  }

  async _ensureVoiceUploaded(apiKey, voicePath) {
    const stat = fs.statSync(voicePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (this._voiceId && this._voiceIdPath === voicePath && this._voiceIdSignature === signature) {
      return this._voiceId;
    }

    const voiceBase64 = 'data:audio/wav;base64,' + fs.readFileSync(voicePath).toString('base64');
    const res = await this._apiRequest('POST', '/v1/tts/voices', apiKey, {
      voice: voiceBase64,
      name: path.basename(voicePath, '.wav'),
    });
    if (!res.voice_id) throw new Error('Voice upload failed: no voice_id returned');

    this._voiceId = res.voice_id;
    this._voiceIdPath = voicePath;
    this._voiceIdSignature = signature;
    return this._voiceId;
  }

  async _apiRequest(method, endpoint, apiKey, body) {
    const res = await fetch(`${get429BaseUrl()}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw make429ApiError(`429 API ${method} ${endpoint} -> HTTP ${res.status}: ${txt}`, res.status);
    }
    return res.json();
  }

  async _synthesizeShortWithRetries(text, outputPath, apiKey, voiceId) {
    const maxRetries = readMaxRetries();
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this._synthesizeShort(text, outputPath, apiKey, voiceId);
      } catch (err) {
        const shouldRetry = err.retryable === true && attempt < maxRetries;
        if (!shouldRetry) throw err;

        const retryDelayMs = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[tts:429] short synthesis failed (${err.message}); ` +
          `retrying in ${retryDelayMs}ms (${attempt + 1}/${maxRetries})`
        );
        await delay(retryDelayMs);
      }
    }
    throw new Error('429 TTS retry loop exhausted unexpectedly');
  }

  async _synthesizeShort(text, outputPath, apiKey, voiceId) {
    const body = JSON.stringify({
      text,
      voice_id: voiceId,
      language: 'en',
      exaggeration: 0.5,
      format: 'mp3',
    });

    await new Promise((resolve, reject) => {
      const url = new URL(`${get429BaseUrl()}/v1/tts/synthesize`);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(make429ApiError(`429 TTS HTTP ${res.statusCode}`, res.statusCode));
          }
          const out = fs.createWriteStream(outputPath);
          res.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          res.on('aborted', () => reject(new Error('429 TTS response ended before audio generation completed')));
          res.on('error', reject);
        }
      );
      req.setTimeout(0);
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    return outputPath;
  }

  async _synthesizeLong(text, outputPath, apiKey, voiceId) {
    const body = JSON.stringify({
      text,
      voice_id: voiceId,
      language: 'en',
      exaggeration: 0.5,
    });

    const audioChunks = [];

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const url = new URL(`${get429BaseUrl()}/v1/tts/long`);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Accept: 'text/event-stream',
          },
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return fail(make429ApiError(`429 TTS long-form HTTP ${res.statusCode}`, res.statusCode));
          }

          let buf = '';
          res.setEncoding('utf8');

          res.on('data', (chunk) => {
            buf += chunk;
            const parts = buf.split('\n\n');
            buf = parts.pop();

            for (const part of parts) {
              const dataLines = part
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trim());
              if (!dataLines.length) continue;

              let event;
              try {
                event = JSON.parse(dataLines.join('\n'));
              } catch {
                continue;
              }

              if (event.type === 'chunk') {
                const audio = Buffer.from(event.audio || '', 'base64');
                audioChunks.push(audio);
                console.log(
                  `[tts:429] chunk ${event.chunk_index + 1}/${event.total_chunks} ` +
                  `(${(audio.length / 1024).toFixed(0)} KB) elapsed ${event.elapsed_ms}ms`
                );
              } else if (event.type === 'done') {
                const usage = event.usage || {};
                console.log(
                  `[tts:429] done - ${usage.chunks ?? audioChunks.length} chunks, ` +
                  `${usage.input_chars ?? text.length} chars, ${event.elapsed_ms}ms`
                );
              } else if (event.type === 'error') {
                fail(make429ApiError(
                  `429 TTS long-form error on chunk ${event.chunk_index}: ${event.error}`,
                  event.status_code || 500
                ));
              }
            }
          });

          res.on('end', done);
          res.on('aborted', () => fail(new Error('429 TTS long-form response ended before audio generation completed')));
          res.on('error', fail);
        }
      );

      req.setTimeout(0);
      req.on('error', fail);
      req.write(body);
      req.end();
    });

    if (audioChunks.length === 0) {
      throw new Error('429 TTS long-form returned no audio chunks');
    }

    fs.writeFileSync(outputPath, Buffer.concat(audioChunks));
    return outputPath;
  }
}

module.exports = Remote429TTSProvider;
