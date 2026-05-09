'use strict';

const { google } = require('googleapis');
const { makeGoogleClient } = require('./_googleAuth');

const GoogleCalendarTool = {
  name: 'google_calendar',
  description: 'Manage Google Calendar: create events and list upcoming events. Use for any request to schedule something, add something to the calendar, or check what is coming up.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create_event', 'list_events'],
        description: 'Action to perform',
      },
      title: {
        type: 'string',
        description: 'Event title (required for create_event)',
      },
      start: {
        type: 'string',
        description: 'Start time in ISO 8601 format, e.g. "2026-05-10T14:00:00" (required for create_event)',
      },
      end: {
        type: 'string',
        description: 'End time in ISO 8601 format. Defaults to 1 hour after start if omitted.',
      },
      description: {
        type: 'string',
        description: 'Event description or notes (optional)',
      },
      location: {
        type: 'string',
        description: 'Event location (optional)',
      },
      max_results: {
        type: 'number',
        description: 'Max events to return for list_events (default: 10)',
      },
    },
    required: ['action'],
  },

  async execute({ action, title, start, end, description, location, max_results = 10 }) {
    const client = makeGoogleClient();
    if (typeof client === 'string') return client;

    const calendar = google.calendar({ version: 'v3', auth: client });

    try {
      if (action === 'create_event') {
        if (!title) return 'title is required for create_event';
        if (!start) return 'start is required for create_event (ISO 8601, e.g. "2026-05-10T14:00:00")';

        const startDate = new Date(start);
        const endDate = end ? new Date(end) : new Date(startDate.getTime() + 60 * 60 * 1000);

        if (isNaN(startDate.getTime())) return `Invalid start time: "${start}" — use ISO 8601 format`;

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

        const url = r.data.htmlLink;
        console.log(`[calendar] Created event: "${title}" → ${url}`);
        return `Event created: "${title}" on ${startDate.toDateString()} — ${url}`;
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

        const list = events
          .map(e => `- ${e.summary} (${new Date(e.start.dateTime || e.start.date).toLocaleString()})`)
          .join('\n');

        return `Upcoming events:\n${list}`;
      }

      return `Unknown action: ${action}. Valid actions: create_event, list_events`;
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      console.error(`[calendar] Error (${action}):`, detail);
      if (err.response?.status === 403) {
        return 'Google Calendar permission denied — disconnect and reconnect Google in /settings to authorize calendar access.';
      }
      return `Google Calendar error: ${detail}`;
    }
  },
};

module.exports = GoogleCalendarTool;
