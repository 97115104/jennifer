'use strict';

const { google } = require('googleapis');
const { makeGoogleClient } = require('./_googleAuth');

const GoogleDocsTool = {
  name: 'google_docs',
  description: 'Create Google Docs and Google Sheets. Use for requests like "create a doc with...", "make a spreadsheet of...", "save this to a Google Sheet", or "create a doc from this search result".',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create_doc', 'create_sheet', 'append_to_sheet'],
        description: 'Action to perform',
      },
      title: {
        type: 'string',
        description: 'Document or spreadsheet title (required for create_doc and create_sheet)',
      },
      content: {
        type: 'string',
        description: 'Text content for the document (for create_doc)',
      },
      rows: {
        type: 'array',
        description: 'Data rows for the spreadsheet (for create_sheet or append_to_sheet). Each row is an array of cell values.',
        items: { type: 'array', items: { type: 'string' } },
      },
      spreadsheet_id: {
        type: 'string',
        description: 'Spreadsheet ID for append_to_sheet (from the URL of an existing sheet)',
      },
      sheet_tab: {
        type: 'string',
        description: 'Sheet tab name (default: "Sheet1")',
      },
    },
    required: ['action'],
  },

  async execute({ action, title, content, rows, spreadsheet_id, sheet_tab = 'Sheet1' }) {
    const client = makeGoogleClient();
    if (typeof client === 'string') return client;

    try {
      if (action === 'create_doc') {
        if (!title) return 'title is required for create_doc';

        const docs = google.docs({ version: 'v1', auth: client });
        const doc = await docs.documents.create({ requestBody: { title } });
        const docId = doc.data.documentId;

        if (content && content.trim()) {
          await docs.documents.batchUpdate({
            documentId: docId,
            requestBody: {
              requests: [{ insertText: { location: { index: 1 }, text: content.trim() } }],
            },
          });
        }

        const url = `https://docs.google.com/document/d/${docId}/edit`;
        console.log(`[gdocs] Created doc: "${title}" (${content?.length || 0} chars) → ${url}`);
        return `Google Doc created: "${title}" — ${url}`;
      }

      if (action === 'create_sheet') {
        if (!title) return 'title is required for create_sheet';

        const sheets = google.sheets({ version: 'v4', auth: client });
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
        console.log(`[gsheets] Created sheet: "${title}" (${rows?.length || 0} rows) → ${url}`);
        return `Google Sheet created: "${title}" with ${rows?.length || 0} rows — ${url}`;
      }

      if (action === 'append_to_sheet') {
        if (!spreadsheet_id) return 'spreadsheet_id is required for append_to_sheet';
        if (!rows || rows.length === 0) return 'rows is required for append_to_sheet';

        const sheets = google.sheets({ version: 'v4', auth: client });
        await sheets.spreadsheets.values.append({
          spreadsheetId: spreadsheet_id,
          range: `${sheet_tab}!A1`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: rows },
        });

        console.log(`[gsheets] Appended ${rows.length} rows to ${spreadsheet_id}`);
        return `Appended ${rows.length} row(s) to spreadsheet https://docs.google.com/spreadsheets/d/${spreadsheet_id}/edit`;
      }

      return `Unknown action: ${action}. Valid actions: create_doc, create_sheet, append_to_sheet`;
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      console.error(`[gdocs] Error (${action}):`, detail);
      if (err.response?.status === 403) {
        return 'Google Docs/Sheets permission denied — disconnect and reconnect Google in /settings to authorize Docs and Sheets access.';
      }
      return `Google Docs error: ${detail}`;
    }
  },
};

module.exports = GoogleDocsTool;
