const path = require('path');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/covers', express.static(path.join(ROOT, 'data', 'covers')));
  return app;
}

module.exports = { createApp };
