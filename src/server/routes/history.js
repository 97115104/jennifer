'use strict';

const express = require('express');
const ConversationHistory = require('../../core/ConversationHistory');

function createHistoryRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    try { res.json(ConversationHistory.list()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/:id', (req, res) => {
    const entry = ConversationHistory.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  });

  router.delete('/:id', (req, res) => {
    const deleted = ConversationHistory.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = createHistoryRouter;
