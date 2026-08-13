const path = require('path');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/covers', express.static(path.join(ROOT, 'data', 'covers')));

  const masters = require('./routes/masters.js');
  app.use('/api/categories', masters.categories);
  app.use('/api/shelves', masters.shelves);
  app.use('/api/borrowers', masters.borrowers);
  app.use('/api', require('./routes/lookup.js'));
  app.use('/api/titles', require('./routes/titles.js'));
  app.use('/api/copies', require('./routes/copies.js'));
  app.use('/api', require('./routes/scan.js'));
  app.use('/api', require('./routes/search.js'));

  // 統一錯誤處理：不把 stack trace 丟給前端
  app.use((err, req, res, _next) => {
    console.error('[API]', err.message);
    res.status(500).json({ error: '系統錯誤：' + err.message });
  });

  return app;
}

module.exports = { createApp };
