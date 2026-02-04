/**
 * Express Application Setup
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { globalLimiter } = require('./middleware/rateLimit');

const app = express();

// Security middleware
app.use(helmet());

// Global rate limiting (200 req/min per IP)
app.use(globalLimiter);
console.log('📊 Global rate limiting enabled');

// CORS - allow all for now (agents everywhere)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Compression
app.use(compression());

// Request logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Trust proxy
app.set('trust proxy', 1);

const path = require('path');
const publicDir = path.join(__dirname, '../public');

// ==== Routes mounted at /clawswarm (reverse proxy path prefix) ====

// API routes at /clawswarm/api/v1
app.use('/clawswarm/api/v1', routes);

// Static assets (CSS, JS, images, SVG) - serve without index
app.use('/clawswarm', express.static(publicDir, { index: false }));

// Skill file at /clawswarm/skill.md
app.get('/clawswarm/skill.md', (req, res) => {
  res.sendFile(path.join(publicDir, 'skill.md'));
});

// Clean URL routing: /clawswarm/app -> /clawswarm/app.html
const fs = require('fs');
app.get('/clawswarm/:page', (req, res, next) => {
  const page = req.params.page;
  
  // Skip if already has extension (handled by static middleware)
  if (path.extname(page)) {
    return next();
  }
  
  // Check if corresponding .html file exists
  const htmlFile = path.join(publicDir, `${page}.html`);
  if (fs.existsSync(htmlFile)) {
    return res.sendFile(htmlFile);
  }
  
  // Fall back to index.html for SPA-style routing
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Root /clawswarm serves index.html
app.get('/clawswarm', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ==== Legacy routes at root (for backwards compatibility) ====

// API routes also at /api/v1 for direct access
app.use('/api/v1', routes);

// Static files at root for legacy access  
app.use(express.static(publicDir));

// Root landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Skill file at root
app.get('/skill.md', (req, res) => {
  res.sendFile(path.join(publicDir, 'skill.md'));
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
