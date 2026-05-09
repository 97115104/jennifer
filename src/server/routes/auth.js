'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');

function getSettings() {
  return require('../../core/Settings').getInstance();
}

function createAuthRouter(config) {
  const router = express.Router();

  // ─── Google OAuth ──────────────────────────────────────────────────────────

  const googleEnabled = !!(config.google.clientId && config.google.clientSecret);

  function makeGoogleClient() {
    return new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      `http://localhost:${config.port}/auth/google/callback`
    );
  }

  router.get('/google', (req, res) => {
    if (!googleEnabled) {
      console.warn('[auth] Google OAuth not configured — add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to .env');
      return res.redirect('/settings?error=google_not_configured');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = makeGoogleClient().generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.send', 'email', 'profile'],
      state,
      prompt: 'consent',
    });
    console.log('[auth] Redirecting to Google OAuth');
    res.redirect(url);
  });

  router.get('/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/settings?error=${encodeURIComponent(error)}`);
    if (!code || state !== req.session.oauthState) return res.redirect('/settings?error=state_mismatch');

    try {
      const client = makeGoogleClient();
      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);

      const userInfo = google.oauth2({ version: 'v2', auth: client });
      const { data } = await userInfo.userinfo.get();

      getSettings().set('google', {
        connected: true,
        tokens,
        email: data.email,
        name: data.name,
      });

      console.log(`[auth] Google connected: ${data.email}`);
      res.redirect('/settings?connected=google');
    } catch (err) {
      console.error('[auth] Google callback error:', err.message);
      res.redirect(`/settings?error=${encodeURIComponent(err.message)}`);
    }
  });

  router.post('/google/disconnect', (req, res) => {
    getSettings().set('google', { connected: false, tokens: null, email: null, name: null });
    console.log('[auth] Google disconnected');
    res.json({ ok: true });
  });

  // ─── GitHub OAuth ──────────────────────────────────────────────────────────

  const githubEnabled = !!(config.github.clientId && config.github.clientSecret);

  router.get('/github', (req, res) => {
    if (!githubEnabled) {
      console.warn('[auth] GitHub OAuth not configured — add GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET to .env');
      return res.redirect('/settings?error=github_not_configured');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = `https://github.com/login/oauth/authorize?client_id=${config.github.clientId}&scope=repo,user&state=${state}`;
    console.log('[auth] Redirecting to GitHub OAuth');
    res.redirect(url);
  });

  router.get('/github/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/settings?error=${encodeURIComponent(error)}`);
    if (!code || state !== req.session.oauthState) return res.redirect('/settings?error=state_mismatch');

    try {
      const tokenRes = await axios.post(
        'https://github.com/login/oauth/access_token',
        { client_id: config.github.clientId, client_secret: config.github.clientSecret, code },
        { headers: { Accept: 'application/json' } }
      );

      const accessToken = tokenRes.data.access_token;
      if (!accessToken) throw new Error(tokenRes.data.error_description || 'No access token returned');

      const userRes = await axios.get('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Jennifer-AI' },
      });

      getSettings().set('github', {
        connected: true,
        accessToken,
        username: userRes.data.login,
        name: userRes.data.name,
      });

      console.log(`[auth] GitHub connected: ${userRes.data.login}`);
      res.redirect('/settings?connected=github');
    } catch (err) {
      console.error('[auth] GitHub callback error:', err.message);
      res.redirect(`/settings?error=${encodeURIComponent(err.message)}`);
    }
  });

  router.post('/github/disconnect', (req, res) => {
    getSettings().set('github', { connected: false, accessToken: null, username: null, name: null });
    console.log('[auth] GitHub disconnected');
    res.json({ ok: true });
  });

  return router;
}

module.exports = createAuthRouter;
