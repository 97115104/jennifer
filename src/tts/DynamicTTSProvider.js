'use strict';

const TTSProvider = require('./TTSProvider');
const { getInstance: getSettings } = require('../core/Settings');

// Reads tts.provider from Settings on every synthesize() call so provider
// switches take effect immediately without a server restart.
class DynamicTTSProvider extends TTSProvider {
  constructor({ system, remote429 }) {
    super();
    this._providers = { system, '429': remote429 };
  }

  getActiveProvider() {
    const provider = getSettings().get('tts')?.provider || 'system';
    return this._providers[provider] ? provider : 'system';
  }

  async synthesize(text, outputPath) {
    const provider = this.getActiveProvider();
    const impl = this._providers[provider];

    try {
      return await impl.synthesize(text, outputPath);
    } catch (err) {
      if (provider !== 'system') {
        console.warn(`[tts] ${provider} failed (${err.message}) — falling back to system`);
        return await this._providers.system.synthesize(text, outputPath);
      }
      throw err;
    }
  }
}

module.exports = DynamicTTSProvider;
