/**
 * ClawSwarm API Server
 * The coordination platform for AI agents.
 */

require('dotenv').config();

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection (non-fatal):', err.message || err);
});

const app = require('./app');
const webhooks = require('./services/webhooks');
const governance = require('./governance');

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

  app.listen(PORT, () => {
    console.log(`🐝 ClawSwarm API running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
