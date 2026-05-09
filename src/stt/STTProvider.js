'use strict';

class STTProvider {
  constructor(config = {}) {
    this.config = config;
  }

  async initialize() {}

  async transcribe(audioFilePath) {
    throw new Error('transcribe() must be implemented by subclass');
  }
}

module.exports = STTProvider;
