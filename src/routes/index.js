/**
 * API Routes
 */

const express = require('express');
const router = express.Router();

// Route modules (to be implemented)
// const agentsRoutes = require('./agents');
// const tasksRoutes = require('./tasks');
// const channelsRoutes = require('./channels');
// const dmRoutes = require('./dm');

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Placeholder routes
router.get('/agents', (req, res) => {
  res.json({ message: 'Agents endpoint - coming soon' });
});

router.get('/tasks', (req, res) => {
  res.json({ message: 'Tasks endpoint - coming soon' });
});

router.get('/channels', (req, res) => {
  res.json({ message: 'Channels endpoint - coming soon' });
});

// SwarmScript test endpoint
router.post('/swarmscript/parse', (req, res) => {
  const { script } = req.body;
  // TODO: Implement SwarmScript parser
  res.json({ 
    message: 'SwarmScript parser - coming soon',
    received: script 
  });
});

module.exports = router;
