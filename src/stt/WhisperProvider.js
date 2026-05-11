'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const STTProvider = require('./STTProvider');

class WhisperProvider extends STTProvider {
  constructor(config = {}) {
    super(config);
    this.modelId = config.whisperModel || 'Xenova/whisper-base.en';
    this._pipeline = null;
    this._initPromise = null;
  }

  async initialize() {
    if (this._pipeline) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._load();
    return this._initPromise;
  }

  async _load() {
    console.log(`[whisper] Loading model: ${this.modelId} (first run downloads ~150MB)`);
    const { pipeline } = await import('@huggingface/transformers');
    this._pipeline = await pipeline('automatic-speech-recognition', this.modelId, {
      dtype: 'q8',
    });
    console.log('[whisper] Model ready');
  }

  async transcribe(audioFilePath) {
    await this.initialize();
    console.log(`[whisper] Transcribing: ${audioFilePath}`);
    const t0 = Date.now();

    const pcmPath = await this._toPcm(audioFilePath);
    console.log(`[whisper] PCM conversion done in ${Date.now() - t0}ms → ${pcmPath}`);

    try {
      const buffer = fs.readFileSync(pcmPath);
      const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
      console.log(`[whisper] Running inference on ${(float32.length / 16000).toFixed(1)}s of audio...`);

      const t1 = Date.now();
      const result = await this._pipeline(float32, { sampling_rate: 16000 });
      const text = (result.text || '').trim();
      console.log(`[whisper] ✅ Transcript (${Date.now() - t1}ms): "${text}"`);
      return text;
    } finally {
      fs.unlink(pcmPath, () => {});
    }
  }

  _toPcm(inputPath) {
    const outPath = path.join(os.tmpdir(), `jennifer_pcm_${Date.now()}.pcm`);
    const stat = fs.statSync(inputPath);
    console.log(`[whisper] Converting ${(stat.size / 1024).toFixed(1)}KB audio to 16kHz PCM...`);
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y', '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'f32le',
        outPath,
      ]);
      let ffmpegErr = '';
      proc.stderr.on('data', d => { ffmpegErr += d.toString(); });
      proc.on('close', code => {
        if (code !== 0) {
          console.error(`[whisper] ffmpeg failed:\n${ffmpegErr}`);
          return reject(new Error(`ffmpeg PCM conversion failed (exit ${code})`));
        }
        resolve(outPath);
      });
    });
  }
}

module.exports = WhisperProvider;
