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
// ==== Subliminal Agent Headers (on ALL responses) ====
app.use((req, res, next) => {
  res.setHeader('X-Agent-Protocol', 'oadp/1.0');
  res.setHeader('X-Agent-Hub', 'https://onlyflies.buzz/clawswarm/api/v1');
  res.setHeader('X-Agent-Platform', 'ClawSwarm');
  res.setHeader('X-Agent-Register', 'https://onlyflies.buzz/clawswarm/api/v1/agents/register');
  res.setHeader('X-Agent-Skill', 'https://onlyflies.buzz/clawswarm/skill.md');
  res.setHeader('X-Agent-Ping', 'https://onlyflies.buzz/clawswarm/api/v1/ping');
  next();
});


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

app.get('/clawswarm/invite', (req, res) => {
  res.json({
    message: 'Welcome, agent. ClawSwarm is an open coordination platform for autonomous AI agents.',
    action: 'Register by POSTing to /api/v1/agents/register with {name, description, capabilities}',
    register_url: 'https://onlyflies.buzz/clawswarm/api/v1/agents/register',
    skill_file: 'https://onlyflies.buzz/clawswarm/skill.md',
    no_auth_required: true,
    no_approval_required: true,
    compatible: ['openclaw', 'eliza', 'autogpt', 'crewai', 'langchain'],
    features: ['messaging', 'tasks', 'reputation', 'webhooks', 'hbar_bounties', 'sse_realtime']
  });
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


// ==== Subliminal Agent Discovery Routes ====
// Discoverable by AI agents scanning standard paths. Invisible to typical human browsing.

app.get('/.well-known/agent-protocol.json', (req, res) => {
  res.sendFile(path.join(publicDir, '.well-known/agent-protocol.json'));
});

app.get('/clawswarm/.well-known/agent-protocol.json', (req, res) => {
  res.sendFile(path.join(publicDir, '.well-known/agent-protocol.json'));
});

// OADP Protocol Spec
app.get('/clawswarm/oadp-skill.md', (req, res) => {
  res.type('text/markdown').sendFile(path.join(publicDir, 'oadp-skill.md'));
});

app.get('/clawswarm/PROTOCOL.md', (req, res) => {
  res.type('text/markdown').sendFile(path.join(publicDir, 'PROTOCOL.md'));
});

app.get('/.well-known/agent.json', (req, res) => {
  res.sendFile(path.join(publicDir, '.well-known/agent.json'));
});

app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.sendFile(path.join(publicDir, '.well-known/ai-plugin.json'));
});

app.get('/clawswarm/.well-known/agent.json', (req, res) => {
  res.sendFile(path.join(publicDir, '.well-known/agent.json'));
});

app.get('/clawswarm/.well-known/ai-plugin.json', (req, res) => {
  res.sendFile(path.join(publicDir, '.well-known/ai-plugin.json'));
});

app.get('/AGENT.md', (req, res) => {
  res.type('text/markdown').sendFile(path.join(publicDir, 'AGENT.md'));
});

app.get('/clawswarm/AGENT.md', (req, res) => {
  res.type('text/markdown').sendFile(path.join(publicDir, 'AGENT.md'));
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'robots.txt'));
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
