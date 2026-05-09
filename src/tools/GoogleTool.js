'use strict';

/**
 * GoogleTool — unified adapter for all Google services.
 *
 * Single tool, action-based dispatch. Same pattern as GithubTool: one name,
 * all operations, no ambiguity for the model about which tool to call.
 *
 * Services and their actions:
 *   Email    — send_email
 *   Calendar — create_event, list_events, get_event, update_event, delete_event
 *   Docs     — create_doc, read_doc, update_doc, delete_doc
 *   Sheets   — create_sheet, read_sheet, update_sheet, append_to_sheet, clear_sheet, delete_sheet
 */

const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { makeGoogleClient } = require('./_googleAuth');
const MemoryStore = require('../core/MemoryStore');

function getConfig() { return require('../config'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function docToText(doc) {
  const lines = [];
  for (const el of (doc.body?.content || [])) {
    if (el.paragraph) {
      const text = (el.paragraph.elements || []).map(e => e.textRun?.content || '').join('');
      lines.push(text);
    }
  }
  return lines.join('').trim();
}

function handleGoogleError(err, service, action) {
  const status = err.response?.status || err.code;
  const detail = err.response?.data?.error?.message || err.message;
  console.error(`[google/${service}] Error (${action}): ${detail}`);
  if (status === 403 || status === 401) {
    return `Google ${service} permission denied — disconnect and reconnect Google in /settings to authorize ${service} access.`;
  }
  return `Google ${service} error: ${detail}`;
}


// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(client, { to, subject, body }) {
  const gmail = google.gmail({ version: 'v1', auth: client });
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
  console.log(`[google/email] Sent to ${to}: "${subject}"`);
  return `Email sent to ${to} via Gmail.`;
}

async function sendViaSMTP({ to, subject, body }) {
  const config = getConfig();
  const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port === 465,
    auth: { user: config.email.user, pass: config.email.pass },
  });
  await transporter.sendMail({ from: config.email.from, to, subject, text: body });
  console.log(`[google/email] Sent to ${to}: "${subject}" via SMTP`);
  return `Email sent to ${to} via SMTP.`;
}


// ─── Calendar ─────────────────────────────────────────────────────────────────

async function calendarAction(client, params) {
  const { action, title, start, end, description, location, event_id, max_results = 10 } = params;
  const calendar = google.calendar({ version: 'v3', auth: client });

  if (action === 'create_event') {
    if (!title) return 'title is required for create_event';
    if (!start) return 'start is required for create_event (ISO 8601, e.g. "2026-05-10T14:00:00")';
    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) return `Invalid start time: "${start}"`;
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 60 * 60 * 1000);
    const r = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description: description || '',
        location: location || '',
        start: { dateTime: startDate.toISOString(), timeZone: 'UTC' },
        end: { dateTime: endDate.toISOString(), timeZone: 'UTC' },
      },
    });
    console.log(`[google/calendar] Created event: "${title}" id=${r.data.id}`);
    return `Event created: "${title}" on ${startDate.toDateString()} — ${r.data.htmlLink} (id: ${r.data.id})`;
  }

  if (action === 'list_events') {
    const r = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: Math.min(Number(max_results) || 10, 25),
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = r.data.items || [];
    if (events.length === 0) return 'No upcoming events found.';
    return 'Upcoming events:\n' + events.map(e => {
      const t = e.start.dateTime || e.start.date;
      return `- [${e.id}] ${e.summary} (${new Date(t).toLocaleString()})`;
    }).join('\n');
  }

  if (action === 'get_event') {
    if (!event_id) return 'event_id is required for get_event';
    const r = await calendar.events.get({ calendarId: 'primary', eventId: event_id });
    const e = r.data;
    return JSON.stringify({
      id: e.id, title: e.summary,
      start: e.start, end: e.end,
      description: e.description, location: e.location, link: e.htmlLink,
    });
  }

  if (action === 'update_event') {
    if (!event_id) return 'event_id is required for update_event';
    const patch = {};
    if (title) patch.summary = title;
    if (description !== undefined) patch.description = description;
    if (location !== undefined) patch.location = location;
    if (start) {
      const d = new Date(start);
      if (isNaN(d.getTime())) return `Invalid start time: "${start}"`;
      patch.start = { dateTime: d.toISOString(), timeZone: 'UTC' };
    }
    if (end) {
      const d = new Date(end);
      if (isNaN(d.getTime())) return `Invalid end time: "${end}"`;
      patch.end = { dateTime: d.toISOString(), timeZone: 'UTC' };
    }
    const r = await calendar.events.patch({ calendarId: 'primary', eventId: event_id, requestBody: patch });
    console.log(`[google/calendar] Updated event: ${event_id}`);
    return `Event updated: "${r.data.summary}" — ${r.data.htmlLink}`;
  }

  if (action === 'delete_event') {
    if (!event_id) return 'event_id is required for delete_event';
    await calendar.events.delete({ calendarId: 'primary', eventId: event_id });
    console.log(`[google/calendar] Deleted event: ${event_id}`);
    return `Event deleted: ${event_id}`;
  }

  return `Unknown calendar action: ${action}`;
}


// ─── Docs ─────────────────────────────────────────────────────────────────────

async function docsAction(client, params) {
  const { action, title, content, doc_id, mode = 'append' } = params;
  const docs = google.docs({ version: 'v1', auth: client });
  const drive = google.drive({ version: 'v3', auth: client });

  if (action === 'create_doc') {
    if (!title) return 'title is required for create_doc';
    const doc = await docs.documents.create({ requestBody: { title } });
    const docId = doc.data.documentId;
    if (content && content.trim()) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: [{ insertText: { location: { index: 1 }, text: content.trim() } }] },
      });
    }
    const url = `https://docs.google.com/document/d/${docId}/edit`;
    console.log(`[google/docs] Created: "${title}" → ${url}`);
    return `Google Doc created: "${title}" — ${url} (id: ${docId})`;
  }

  if (action === 'read_doc') {
    if (!doc_id) return 'doc_id is required for read_doc';
    const doc = await docs.documents.get({ documentId: doc_id });
    const text = docToText(doc.data);
    const truncated = text.length > 8000;
    return truncated ? text.slice(0, 8000) + '\n\n[...truncated at 8000 chars]' : text;
  }

  if (action === 'update_doc') {
    if (!doc_id) return 'doc_id is required for update_doc';
    if (!content) return 'content is required for update_doc';

    if (mode === 'replace') {
      const doc = await docs.documents.get({ documentId: doc_id });
      const bodyContent = doc.data.body.content;
      const endIndex = bodyContent[bodyContent.length - 1].endIndex;
      const requests = [];
      if (endIndex > 2) {
        requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
      }
      requests.push({ insertText: { location: { index: 1 }, text: content } });
      await docs.documents.batchUpdate({ documentId: doc_id, requestBody: { requests } });
    } else {
      // append: insert before the mandatory final newline
      const doc = await docs.documents.get({ documentId: doc_id });
      const bodyContent = doc.data.body.content;
      const insertAt = bodyContent[bodyContent.length - 1].endIndex - 1;
      await docs.documents.batchUpdate({
        documentId: doc_id,
        requestBody: { requests: [{ insertText: { location: { index: insertAt }, text: '\n' + content } }] },
      });
    }
    const url = `https://docs.google.com/document/d/${doc_id}/edit`;
    console.log(`[google/docs] Updated (${mode}): ${doc_id}`);
    return `Document updated (${mode}) — ${url}`;
  }

  if (action === 'delete_doc') {
    if (!doc_id) return 'doc_id is required for delete_doc';
    await drive.files.trash({ fileId: doc_id });
    console.log(`[google/docs] Trashed: ${doc_id}`);
    return `Document moved to trash: ${doc_id}`;
  }

  return `Unknown docs action: ${action}`;
}


// ─── Sheets ───────────────────────────────────────────────────────────────────

async function sheetsAction(client, params) {
  const { action, title, rows, spreadsheet_id, range, sheet_tab = 'Sheet1' } = params;
  const sheets = google.sheets({ version: 'v4', auth: client });
  const drive = google.drive({ version: 'v3', auth: client });

  if (action === 'create_sheet') {
    if (!title) return 'title is required for create_sheet';
    const spreadsheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: sheet_tab } }],
      },
    });
    const spreadsheetId = spreadsheet.data.spreadsheetId;
    if (rows && rows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheet_tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      });
    }
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    console.log(`[google/sheets] Created: "${title}" (${rows?.length || 0} rows) → ${url}`);
    return `Google Sheet created: "${title}" with ${rows?.length || 0} rows — ${url} (id: ${spreadsheetId})`;
  }

  if (action === 'read_sheet') {
    if (!spreadsheet_id) return 'spreadsheet_id is required for read_sheet';
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheet_id,
      range: range || `${sheet_tab}!A1:Z1000`,
    });
    const data = r.data.values || [];
    if (data.length === 0) return 'Sheet is empty.';
    return JSON.stringify(data);
  }

  if (action === 'update_sheet') {
    if (!spreadsheet_id) return 'spreadsheet_id is required for update_sheet';
    if (!rows || rows.length === 0) return 'rows is required for update_sheet';
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheet_id,
      range: range || `${sheet_tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheet_id}/edit`;
    console.log(`[google/sheets] Updated ${rows.length} rows in ${spreadsheet_id}`);
    return `Sheet updated: ${rows.length} rows written — ${url}`;
  }

  if (action === 'append_to_sheet') {
    if (!spreadsheet_id) return 'spreadsheet_id is required for append_to_sheet';
    if (!rows || rows.length === 0) return 'rows is required for append_to_sheet';
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheet_id,
      range: `${sheet_tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheet_id}/edit`;
    console.log(`[google/sheets] Appended ${rows.length} rows to ${spreadsheet_id}`);
    return `Appended ${rows.length} row(s) — ${url}`;
  }

  if (action === 'clear_sheet') {
    if (!spreadsheet_id) return 'spreadsheet_id is required for clear_sheet';
    await sheets.spreadsheets.values.clear({
      spreadsheetId: spreadsheet_id,
      range: range || `${sheet_tab}!A1:Z1000`,
    });
    console.log(`[google/sheets] Cleared ${spreadsheet_id}`);
    return `Sheet cleared: ${spreadsheet_id}`;
  }

  if (action === 'delete_sheet') {
    if (!spreadsheet_id) return 'spreadsheet_id is required for delete_sheet';
    await drive.files.trash({ fileId: spreadsheet_id });
    console.log(`[google/sheets] Trashed: ${spreadsheet_id}`);
    return `Spreadsheet moved to trash: ${spreadsheet_id}`;
  }

  return `Unknown sheets action: ${action}`;
}


// ─── Tool definition ──────────────────────────────────────────────────────────

const GoogleTool = {
  name: 'google',
  description: `Unified Google services adapter. All Google operations go through this one tool.
Uses the connected Google account automatically — no user email, calendar ID, or auth is needed.

SERVICES AND ACTIONS:
  Email    — send_email(to, subject, body)
  Calendar — list_events() [NO params needed], create_event(title, start, end?), get_event(event_id),
             update_event(event_id, ...), delete_event(event_id)
  Docs     — create_doc(title, content?), read_doc(doc_id), update_doc(doc_id, content, mode), delete_doc(doc_id)
  Sheets   — create_sheet(title, rows?), read_sheet(spreadsheet_id), update_sheet(spreadsheet_id, rows),
             append_to_sheet(spreadsheet_id, rows), clear_sheet(spreadsheet_id), delete_sheet(spreadsheet_id)

IMPORTANT: For list_events call with ONLY action:"list_events" — no other parameters. Uses primary calendar automatically.
update_doc mode: "append" (add to end) or "replace" (overwrite all content)
Dates use ISO 8601: "2026-05-10T14:00:00". IDs are returned by create actions.`,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'send_email',
          'create_event', 'list_events', 'get_event', 'update_event', 'delete_event',
          'create_doc', 'read_doc', 'update_doc', 'delete_doc',
          'create_sheet', 'read_sheet', 'update_sheet', 'append_to_sheet', 'clear_sheet', 'delete_sheet',
        ],
        description: 'The Google operation to perform',
      },
      // Email
      to:      { type: 'string', description: 'Recipient email address (send_email)' },
      subject: { type: 'string', description: 'Email subject (send_email)' },
      body:    { type: 'string', description: 'Email body plain text (send_email)' },
      // Calendar
      title:       { type: 'string', description: 'Event title or document title' },
      start:       { type: 'string', description: 'Event start time ISO 8601, e.g. "2026-05-10T14:00:00"' },
      end:         { type: 'string', description: 'Event end time ISO 8601. Defaults to 1 hour after start.' },
      description: { type: 'string', description: 'Event description or notes' },
      location:    { type: 'string', description: 'Event location (calendar events)' },
      event_id:    { type: 'string', description: 'Calendar event ID (get/update/delete_event)' },
      max_results: { type: 'number', description: 'Max results for list_events (default 10)' },
      // Docs
      doc_id:  { type: 'string', description: 'Google Doc document ID (read/update/delete_doc)' },
      content: { type: 'string', description: 'Text content for docs (create_doc, update_doc)' },
      mode:    { type: 'string', enum: ['append', 'replace'], description: 'update_doc mode: append or replace (default: append)' },
      // Sheets
      spreadsheet_id: { type: 'string', description: 'Spreadsheet ID (read/update/append/clear/delete_sheet)' },
      rows: {
        type: 'array',
        description: 'Data rows for sheets. Each row is an array of cell values.',
        items: { type: 'array', items: { type: 'string' } },
      },
      range:     { type: 'string', description: 'A1 notation range for sheets, e.g. "Sheet1!A1:D10"' },
      sheet_tab: { type: 'string', description: 'Sheet tab name (default: "Sheet1")' },
    },
    required: ['action'],
  },

  async execute(params, ctx = {}) {
    const { action } = params;

    // ── Email ──────────────────────────────────────────────────────────────
    if (action === 'send_email') {
      let { to, subject, body } = params;
      if (!to || !subject || !body) return 'to, subject, and body are required for send_email';

      // Resolve named contacts from memory store
      if (to && !to.includes('@')) {
        const [match] = MemoryStore.lookup(to, 'email', 1);
        if (!match) return `No saved email found for "${to}". Add it in /memory first.`;
        console.log(`[google/email] Resolved "${to}" → ${match.value}`);
        to = match.value;
      }

      const client = makeGoogleClient();
      if (typeof client !== 'string') {
        try {
          return await sendEmail(client, { to, subject, body });
        } catch (err) {
          const status = err.response?.status || err.status || err.code;
          if (status === 403 || err.message?.includes('Insufficient Permission')) {
            return 'Gmail permission denied — disconnect and reconnect Google in /settings to re-authorize Gmail.';
          }
          console.error('[google/email] Gmail API failed, trying SMTP:', err.message);
        }
      }

      // SMTP fallback
      const config = getConfig();
      if (!config.email.host || !config.email.user) {
        return 'Email not configured. Connect Google in /settings or add SMTP_HOST, SMTP_USER, SMTP_PASS to .env.';
      }
      try {
        return await sendViaSMTP({ to, subject, body });
      } catch (err) {
        return `Failed to send email: ${err.message}`;
      }
    }

    // ── Calendar ───────────────────────────────────────────────────────────
    const CALENDAR_ACTIONS = ['create_event', 'list_events', 'get_event', 'update_event', 'delete_event'];
    if (CALENDAR_ACTIONS.includes(action)) {
      const client = makeGoogleClient();
      if (typeof client === 'string') return client;
      try {
        return await calendarAction(client, params);
      } catch (err) {
        return handleGoogleError(err, 'Calendar', action);
      }
    }

    // ── Docs ───────────────────────────────────────────────────────────────
    const DOCS_ACTIONS = ['create_doc', 'read_doc', 'update_doc', 'delete_doc'];
    if (DOCS_ACTIONS.includes(action)) {
      const client = makeGoogleClient();
      if (typeof client === 'string') return client;
      try {
        return await docsAction(client, params);
      } catch (err) {
        return handleGoogleError(err, 'Docs', action);
      }
    }

    // ── Sheets ─────────────────────────────────────────────────────────────
    const SHEETS_ACTIONS = ['create_sheet', 'read_sheet', 'update_sheet', 'append_to_sheet', 'clear_sheet', 'delete_sheet'];
    if (SHEETS_ACTIONS.includes(action)) {
      const client = makeGoogleClient();
      if (typeof client === 'string') return client;
      try {
        return await sheetsAction(client, params);
      } catch (err) {
        return handleGoogleError(err, 'Sheets', action);
      }
    }

    return `Unknown action: ${action}`;
  },
};

module.exports = GoogleTool;
