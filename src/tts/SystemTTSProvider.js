'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const TTSProvider = require('./TTSProvider');

class SystemTTSProvider extends TTSProvider {
  constructor(config = {}) {
    super(config);
    this.platform = process.platform;
    this.voice = config.voice || null;
  }

  async synthesize(text, outputPath) {
    switch (this.platform) {
      case 'darwin': return this._macSay(text, outputPath);
      case 'linux':  return this._linuxEspeak(text, outputPath);
      case 'win32':  return this._windowsSapi(text, outputPath);
      default: throw new Error(`Unsupported platform: ${this.platform}`);
    }
  }

  _macSay(text, outputPath) {
    const aiffPath = outputPath.replace(/\.(mp3|wav)$/, '.aiff');
    return new Promise((resolve, reject) => {
      const sayArgs = ['-o', aiffPath];
      if (this.voice) sayArgs.push('-v', this.voice);
      sayArgs.push(text);

      const say = spawn('say', sayArgs);
      say.on('close', code => {
        if (code !== 0) return reject(new Error(`say failed (exit ${code})`));
        const ff = spawn('ffmpeg', ['-y', '-i', aiffPath, outputPath]);
        ff.stderr.on('data', () => {});
        ff.on('close', code2 => {
          fs.unlink(aiffPath, () => {});
          if (code2 !== 0) return reject(new Error(`ffmpeg failed (exit ${code2})`));
          resolve(outputPath);
        });
      });
    });
  }

  _linuxEspeak(text, outputPath) {
    return new Promise((resolve, reject) => {
      const wavPath = outputPath.replace(/\.mp3$/, '.wav');
      const args = ['-w', wavPath, text];
      if (this.voice) args.push('-v', this.voice);

      const espeak = spawn('espeak-ng', args);
      espeak.on('close', code => {
        if (code !== 0) return reject(new Error(`espeak failed (exit ${code})`));
        if (!outputPath.endsWith('.mp3')) return resolve(wavPath);
        const ff = spawn('ffmpeg', ['-y', '-i', wavPath, outputPath]);
        ff.stderr.on('data', () => {});
        ff.on('close', () => { fs.unlink(wavPath, () => {}); resolve(outputPath); });
      });
    });
  }

  _windowsSapi(text, outputPath) {
    return new Promise((resolve, reject) => {
      const wavPath = outputPath.replace(/\.mp3$/, '.wav');
      const safeText = text.replace(/"/g, '\\"').replace(/'/g, "\\'");
      const ps = [
        'Add-Type -AssemblyName System.Speech',
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
        `$s.SetOutputToWaveFile("${wavPath}")`,
        `$s.Speak("${safeText}")`,
        '$s.Dispose()',
      ].join('; ');

      const proc = spawn('powershell', ['-Command', ps]);
      proc.on('close', code => {
        if (code !== 0) return reject(new Error(`PowerShell TTS failed (exit ${code})`));
        if (!outputPath.endsWith('.mp3')) return resolve(wavPath);
        const ff = spawn('ffmpeg', ['-y', '-i', wavPath, outputPath]);
        ff.stderr.on('data', () => {});
        ff.on('close', () => { fs.unlink(wavPath, () => {}); resolve(outputPath); });
      });
    });
  }
}

module.exports = SystemTTSProvider;
