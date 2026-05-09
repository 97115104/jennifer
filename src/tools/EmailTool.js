'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

const EmailTool = {
  name: 'send_email',
  description: 'Send an email. Use when the user asks to send an email to someone.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text)' },
    },
    required: ['to', 'subject', 'body'],
  },

  async execute({ to, subject, body }) {
    if (!config.email.host || !config.email.user) {
      return 'Email not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS to .env to enable.';
    }

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

    return `Email sent to ${to}.`;
  },
};

module.exports = EmailTool;
