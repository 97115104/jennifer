'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_429_VOICE_NAME = 'steve';
const VOICES_DIR = path.join(__dirname, '../../data/voices');

function getDefault429VoicePath() {
  const voicePath = path.join(VOICES_DIR, `${DEFAULT_429_VOICE_NAME}.wav`);
  return fs.existsSync(voicePath) ? voicePath : '';
}

function resolve429VoicePath(voiceRef429) {
  if (voiceRef429 && fs.existsSync(voiceRef429)) return voiceRef429;
  return getDefault429VoicePath();
}

module.exports = {
  DEFAULT_429_VOICE_NAME,
  getDefault429VoicePath,
  resolve429VoicePath,
};
