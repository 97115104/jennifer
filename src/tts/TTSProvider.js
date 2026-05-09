'use strict';

class TTSProvider {
  constructor(config = {}) {
    this.config = config;
  }

  async initialize() {}

  async synthesize(text, outputPath) {
    throw new Error('synthesize() must be implemented by subclass');
  }
}

module.exports = TTSProvider;
