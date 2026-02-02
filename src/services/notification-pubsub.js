/**
 * notification-pubsub.js - Scalable notifications via Redis Pub/Sub
 * 
 * Architecture:
 * - ClawSwarm API publishes to Redis channel
 * - SSE servers subscribe and push to connected agents
 * - Scales horizontally: add more SSE servers behind load balancer
 * - Handles 100K+ agents across multiple nodes
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CHANNEL_PREFIX = 'clawswarm:notify:';

// Publisher (used by API to send notifications)
let publisher = null;

// Subscriber (used by SSE handlers to receive)
let subscriber = null;

// Local handlers for this process
const handlers = new Map(); // agentId -> Set of callbacks

/**
 * Initialize pub/sub connections
 */
async function initialize() {
  try {
    publisher = new Redis(REDIS_URL);
    subscriber = new Redis(REDIS_URL);
    
    // Handle incoming messages
    subscriber.on('pmessage', (pattern, channel, message) => {
      const agentId = channel.replace(CHANNEL_PREFIX, '');
      const callbacks = handlers.get(agentId);
      
      if (callbacks && callbacks.size > 0) {
        const data = JSON.parse(message);
        for (const cb of callbacks) {
          try {
            cb(data);
          } catch (e) {
            console.error(`Handler error for ${agentId}:`, e.message);
          }
        }
      }
    });
    
    // Subscribe to all agent notifications
    await subscriber.psubscribe(`${CHANNEL_PREFIX}*`);
    
    console.log('📡 Notification pub/sub initialized');
    return true;
  } catch (err) {
    console.error('Failed to init notification pub/sub:', err.message);
    return false;
  }
}

/**
 * Publish notification to an agent (called by API)
 */
async function publish(agentId, notification) {
  if (!publisher) {
    console.warn('Publisher not initialized');
    return false;
  }
  
  const channel = `${CHANNEL_PREFIX}${agentId}`;
  const message = JSON.stringify({
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...notification,
    createdAt: new Date().toISOString()
  });
  
  await publisher.publish(channel, message);
  console.log(`📡 Published to ${agentId}`);
  return true;
}

/**
 * Subscribe to notifications for an agent (called by SSE handler)
 */
function subscribe(agentId, callback) {
  if (!handlers.has(agentId)) {
    handlers.set(agentId, new Set());
  }
  handlers.get(agentId).add(callback);
  
  console.log(`📡 Subscribed: ${agentId} (${handlers.get(agentId).size} handlers)`);
  
  // Return unsubscribe function
  return () => {
    handlers.get(agentId)?.delete(callback);
    console.log(`📡 Unsubscribed: ${agentId}`);
  };
}

/**
 * Get stats
 */
function getStats() {
  let totalHandlers = 0;
  const agents = [];
  
  for (const [agentId, cbs] of handlers) {
    if (cbs.size > 0) {
      agents.push({ agentId, handlers: cbs.size });
      totalHandlers += cbs.size;
    }
  }
  
  return { totalHandlers, agents };
}

/**
 * Cleanup
 */
async function shutdown() {
  if (subscriber) {
    await subscriber.punsubscribe();
    subscriber.disconnect();
  }
  if (publisher) {
    publisher.disconnect();
  }
}

module.exports = {
  initialize,
  publish,
  subscribe,
  getStats,
  shutdown
};
