'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const MemoryStore = require('../core/MemoryStore');

function getSettings() {
  try { return require('../core/Settings').getInstance(); } catch { return null; }
}

async function sendViaGmail(tokens, { to, subject, body }) {
  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret
  );
  client.setCredentials(tokens);

  // Persist any refreshed access tokens back to settings automatically
  client.on('tokens', (newTokens) => {
    try {
      const s = getSettings();
      const g = s?.get('google');
      if (g) s.set('google', { ...g, tokens: { ...g.tokens, ...newTokens } });
      console.log('[email/gmail] Tokens refreshed and saved');
    } catch {}
  });

  const gmail = google.gmail({ version: 'v1', auth: client });

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });

  console.log(`[email/gmail] Sent to ${to}: "${subject}"`);
}

async function sendViaSMTP({ to, subject, body }) {
  const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port === 465,
    auth: { user: config.email.user, pass: config.email.pass },
  });

  await transporter.sendMail({
    from: config.email.from,
    to,
    subject,
    text: body,
  });

  console.log(`[email/smtp] Sent to ${to}: "${subject}"`);
}

const EmailTool = {
  name: 'send_email',
  description: 'Send an email. Use when the user asks to send an email. Supports Gmail (when Google is connected in Settings) or SMTP.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject line' },
      body: { type: 'string', description: 'Email body (plain text)' },
    },
    required: ['to', 'subject', 'body'],
  },

  async execute({ to, subject, body }) {
    if (to && !to.includes('@')) {
      const [match] = MemoryStore.lookup(to, 'email', 1);
      if (!match) return `No saved email found for "${to}". Add it in /memory first.`;
      console.log(`[email] Resolved "${to}" to saved contact "${match.key}"`);
      to = match.value;
    }

    const settings = getSettings();
    const google = settings?.get('google');

    // Try Gmail API first if Google is connected
    if (google?.connected && google?.tokens) {
      try {
        await sendViaGmail(google.tokens, { to, subject, body });
        return `Email sent to ${to} via Gmail.`;
      } catch (err) {
        console.error('[email] Gmail API failed:', err.message);
        // 403 = missing gmail.send scope — user must reconnect
        const status = err.response?.status || err.status || err.code;
        if (status === 403 || err.message?.includes('Insufficient Permission')) {
          return 'Gmail permission denied — your Google token is missing the gmail.send scope. '
            + 'Go to /settings → Google tab → Disconnect → Reconnect to re-authorize with Gmail permissions. '
            + 'Also make sure the Gmail API is enabled at https://console.cloud.google.com/apis/library/gmail.googleapis.com';
        }
        console.error('[email] Falling back to SMTP:', err.message);
      }
    }

    // Fall back to SMTP
    if (!config.email.host || !config.email.user) {
      return 'Email not configured. Connect Google in Settings (/settings) or add SMTP_HOST, SMTP_USER, SMTP_PASS to .env.';
    }

    try {
      await sendViaSMTP({ to, subject, body });
      return `Email sent to ${to} via SMTP.`;
    } catch (err) {
      console.error('[email] SMTP error:', err.message);
      return `Failed to send email: ${err.message}`;
    }
  },
};

module.exports = EmailTool;
