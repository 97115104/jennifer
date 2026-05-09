'use strict';

const { google } = require('googleapis');

function getSettings() {
  return require('../core/Settings').getInstance();
}

/**
 * Returns a configured OAuth2 client for any Google API, or a string
 * error message if credentials are missing. Persists refreshed tokens.
 */
function makeGoogleClient() {
  const config = require('../config');
  const settings = getSettings();
  const googleSettings = settings.get('google');

  if (!googleSettings?.connected || !googleSettings?.tokens) {
    return 'Google is not connected. Open /settings and connect your Google account first.';
  }

  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    `http://localhost:${config.port}/auth/google/callback`,
  );

  client.setCredentials(googleSettings.tokens);

  client.on('tokens', (newTokens) => {
    const s = getSettings();
    const g = s?.get('google');
    if (g) s.set('google', { ...g, tokens: { ...g.tokens, ...newTokens } });
  });

  return client;
}

module.exports = { makeGoogleClient };
