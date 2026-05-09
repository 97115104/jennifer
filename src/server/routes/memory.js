'use strict';

const express = require('express');
const MemoryStore = require('../../core/MemoryStore');

function sendError(res, err, status = 400) {
  res.status(status).json({ error: err.message || String(err) });
}

function createMemoryRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ entries: MemoryStore.list() });
  });

  router.post('/', (req, res) => {
    try {
      res.status(201).json({ entry: MemoryStore.create(req.body || {}) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/:id', (req, res) => {
    try {
      res.json({ entry: MemoryStore.update(req.params.id, req.body || {}) });
    } catch (err) {
      const status = err.message === 'Memory entry not found' ? 404 : 400;
      sendError(res, err, status);
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      MemoryStore.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 404);
    }
  });

  return router;
}

module.exports = createMemoryRouter;
