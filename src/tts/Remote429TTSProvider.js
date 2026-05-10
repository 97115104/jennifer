'use strict';

const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const TTSProvider = require('./TTSProvider');
const { getInstance: getSettings } = require('../core/Settings');
const { DEFAULT_429_VOICE_NAME, resolve429VoicePath } = require('./default429Voice');

const TTS_ENDPOINT = 'https://api.429inference.com/v1/tts/synthesize';
const DEFAULT_MAX_CHARS_PER_REQUEST = 1800;
const DEFAULT_MAX_RETRIES = 3;
const execFileAsync = promisify(execFile);

function readMaxCharsPerRequest() {
  const value = parseInt(process.env.TTS_429_MAX_CHARS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_CHARS_PER_REQUEST;
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

function splitOversizedText(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const parts = [];
  let current = '';

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxChars) {
        parts.push(word.slice(i, i + maxChars));
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars) {
      parts.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) parts.push(current);
  return parts;
}

function splitTextFor429TTS(text, maxChars = readMaxCharsPerRequest()) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  const chunks = [];
  let current = '';

  const appendChunk = (piece, separator = '\n\n') => {
    const clean = String(piece || '').trim();
    if (!clean) return;

    if (!current) {
      current = clean;
      return;
    }

    const next = `${current}${separator}${clean}`;
    if (next.length <= maxChars) {
      current = next;
      return;
    }

    chunks.push(current);
    current = clean;
  };

  const appendLongParagraph = (paragraph) => {
    const sentences = paragraph.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [paragraph];
    for (const sentence of sentences) {
      if (sentence.length <= maxChars) {
        appendChunk(sentence, ' ');
      } else {
        for (const part of splitOversizedText(sentence, maxChars)) appendChunk(part, ' ');
      }
    }
  };

  for (const paragraph of normalized.split(/\n\s*\n+/)) {
    if (paragraph.length <= maxChars) appendChunk(paragraph);
    else appendLongParagraph(paragraph);
  }

  if (current) chunks.push(current);
  return chunks;
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

class Remote429TTSProvider extends TTSProvider {
  async synthesize(text, outputPath) {
    const tts = getSettings().get('tts');
    const { apiKey429, voiceRef429 } = tts || {};
    const voicePath = resolve429VoicePath(voiceRef429);

    if (!apiKey429) throw new Error('429 TTS API key is not configured');
    if (!voicePath) throw new Error(`429 TTS needs a saved voice source. Record or upload one in Settings, then click Use. The default "${DEFAULT_429_VOICE_NAME}" voice is missing.`);

    const chunks = splitTextFor429TTS(text);
    if (!chunks.length) throw new Error('429 TTS needs text to synthesize');

    if (chunks.length === 1) {
      await this._synthesizeSingleWithRetries(chunks[0], outputPath, apiKey429, voicePath, 1, 1);
      return outputPath;
    }

    console.log(`[tts:429] Synthesizing ${text.length} chars in ${chunks.length} chunks`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jennifer-429-tts-'));
    const chunkFiles = [];
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunkPath = path.join(tmpDir, `chunk-${String(i).padStart(3, '0')}.mp3`);
        await this._synthesizeSingleWithRetries(chunks[i], chunkPath, apiKey429, voicePath, i + 1, chunks.length);
        chunkFiles.push(chunkPath);
      }
      await this._concatAudioFiles(chunkFiles, outputPath, tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return outputPath;
  }

  async _synthesizeSingleWithRetries(text, outputPath, apiKey429, voicePath, chunkNumber, chunkCount) {
    const maxRetries = readMaxRetries();
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this._synthesizeSingle(text, outputPath, apiKey429, voicePath);
      } catch (err) {
        const shouldRetry = err.retryable === true && attempt < maxRetries;
        if (!shouldRetry) throw err;

        const retryDelayMs = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[tts:429] chunk ${chunkNumber}/${chunkCount} failed (${err.message}); ` +
          `retrying in ${retryDelayMs}ms (${attempt + 1}/${maxRetries})`
        );
        await delay(retryDelayMs);
      }
    }
    throw new Error('429 TTS retry loop exhausted unexpectedly');
  }

  async _synthesizeSingle(text, outputPath, apiKey429, voicePath) {
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
            return reject(make429ApiError(`429 TTS API failed with HTTP ${res.statusCode}`, res.statusCode));
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

  async _concatAudioFiles(files, outputPath, tmpDir) {
    const listPath = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(listPath, files.map(file => `file '${escapeConcatPath(file)}'`).join('\n'));
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath,
    ]);
  }
}

module.exports = Remote429TTSProvider;
