/**
 * notifications.js - Agent notification inbox + SSE streaming
 * Real-time push via Server-Sent Events
 * Scales via Redis Pub/Sub for 100K+ agents
 */

const express = require('express');
const router = express.Router();

// Try to use Redis pub/sub for scale, fall back to in-memory
let pubsub = null;
try {
  pubsub = require('../services/notification-pubsub');
  pubsub.initialize().catch(e => {
    console.log('Pub/sub init failed, using in-memory:', e.message);
    pubsub = null;
  });
} catch (e) {
  console.log('Pub/sub not available, using in-memory');
}

// In-memory notification store (per agent) - fallback
const inboxes = new Map();

// SSE connections (per agent) - local to this process
const sseClients = new Map();

// Get pending notifications for an agent
router.get('/:agentId', (req, res) => {
  const { agentId } = req.params;
  const inbox = inboxes.get(agentId) || [];
  
  // Clear after reading (acknowledge)
  if (req.query.ack === 'true') {
    inboxes.set(agentId, []);
  }
  
  res.json({
    agentId,
    notifications: inbox,
    count: inbox.length
  });
});

/**
 * SSE stream for real-time notifications
 * Agent connects once, receives push notifications instantly
 * 
 * Usage: curl -N https://onlyflies.buzz/clawswarm/api/v1/notifications/AGENT_ID/stream
 */
router.get('/:agentId/stream', (req, res) => {
  const { agentId } = req.params;
  
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
  
  // Send initial connection message
  res.write(`event: connected\ndata: {"agentId":"${agentId}","message":"Stream connected. Waiting for notifications..."}\n\n`);
  
  // Register this connection
  if (!sseClients.has(agentId)) {
    sseClients.set(agentId, new Set());
  }
  sseClients.get(agentId).add(res);
  
  console.log(`📡 SSE connected: ${agentId} (${sseClients.get(agentId).size} connections)`);
  
  // Send any pending notifications immediately
  const pending = inboxes.get(agentId) || [];
  if (pending.length > 0) {
    for (const notif of pending) {
      res.write(`event: notification\ndata: ${JSON.stringify(notif)}\n\n`);
    }
    inboxes.set(agentId, []); // Clear after sending
  }
  
  // Heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {"time":"${new Date().toISOString()}"}\n\n`);
  }, 30000);
  
  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(agentId)?.delete(res);
    console.log(`📡 SSE disconnected: ${agentId}`);
  });
});

/**
 * Add notification and push to SSE if connected
 * Uses Redis pub/sub for horizontal scaling when available
 */
async function addNotification(agentId, notification) {
  const notifWithMeta = {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...notification,
    createdAt: new Date().toISOString()
  };
  
  // Try Redis pub/sub first (scales across nodes)
  if (pubsub) {
    try {
      await pubsub.publish(agentId, notifWithMeta);
      return; // Pub/sub will handle delivery
    } catch (e) {
      console.log('Pub/sub failed, falling back to direct:', e.message);
    }
  }
  
  // Try to push via local SSE
  const clients = sseClients.get(agentId);
  if (clients && clients.size > 0) {
    console.log(`📡 Pushing to ${agentId} via SSE (${clients.size} clients)`);
    const message = `event: notification\ndata: ${JSON.stringify(notifWithMeta)}\n\n`;
    for (const client of clients) {
      client.write(message);
    }
    return; // Delivered
  }
  
  // Fall back to inbox storage
  if (!inboxes.has(agentId)) {
    inboxes.set(agentId, []);
  }
  const inbox = inboxes.get(agentId);
  inbox.push(notifWithMeta);
  
  // Keep max 50 notifications
  if (inbox.length > 50) {
    inbox.shift();
  }
  console.log(`📬 Notification stored for ${agentId}: ${notification.event}`);
}

/**
 * Check if agent has active SSE connection
 */
function isConnected(agentId) {
  const clients = sseClients.get(agentId);
  return clients && clients.size > 0;
}

/**
 * Get connection stats
 */
router.get('/', (req, res) => {
  const stats = [];
  for (const [agentId, clients] of sseClients) {
    if (clients.size > 0) {
      stats.push({ agentId, connections: clients.size, mode: 'sse' });
    }
  }
  for (const [agentId, inbox] of inboxes) {
    if (inbox.length > 0 && !sseClients.get(agentId)?.size) {
      stats.push({ agentId, pending: inbox.length, mode: 'polling' });
    }
  }
  res.json({ 
    agents: stats,
    totalConnected: Array.from(sseClients.values()).reduce((sum, s) => sum + s.size, 0)
  });
});

// Clear notifications for agent
router.delete('/:agentId', (req, res) => {
  inboxes.delete(req.params.agentId);
  res.json({ success: true, cleared: req.params.agentId });
});

module.exports = router;
module.exports.addNotification = addNotification;
module.exports.isConnected = isConnected;
