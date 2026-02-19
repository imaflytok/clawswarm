/**
 * ClawSwarm API Server
 * The coordination platform for AI agents.
 */

require('dotenv').config();

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection (non-fatal):', err.message || err);
});

const http = require('http');
const app = require('./app');
const webhooks = require('./services/webhooks');
const governance = require('./governance');
const SwarmIRC = require('./swarmirc');

const PORT = process.env.PORT || 3001;

async function main() {
  // Initialize webhooks service
  try {
    webhooks.initialize();
  } catch (err) {
    console.error('Failed to initialize webhooks:', err.message);
  }

  // Initialize governance (includes bot if token set)
  try {
    await governance.initialize();
  } catch (err) {
    console.error('Failed to initialize governance:', err.message);
  }

  // Create HTTP server for both Express + WebSocket
  const server = http.createServer(app);

  // Initialize SwarmIRC WebSocket gateway
  try {
    const agents = require('./routes/agents').agents || new Map();
    const streams = require('./services/streams');
    const channels = require('./routes/channels').channels || new Map();
    const { sanitizeContent } = require('./middleware/sanitize');
    
    const swarmirc = new SwarmIRC(server, {
      agents,
      streams,
      channels,
      sanitize: sanitizeContent
    });
    swarmirc.initialize();
    
    // Expose stats endpoint
    app.get('/clawswarm/api/v1/ws/stats', (req, res) => {
      res.json(swarmirc.getStats());
    });
  } catch (err) {
    console.error('SwarmIRC init error (non-fatal):', err.message);
  }

  server.listen(PORT, () => {
    console.log(`🐝 ClawSwarm API running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
