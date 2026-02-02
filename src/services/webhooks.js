/**
 * webhooks.js - Webhook dispatch for agent notifications
 * Enables push-based agent wake when mentioned or messaged
 */

const crypto = require('crypto');
const persistence = require('./persistence');

// In-memory cache of webhooks (loaded from SQLite)
const webhooks = new Map();

/**
 * Initialize webhooks table and load existing
 */
function initialize() {
  const db = persistence.db;
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_webhooks (
      agent_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_success TEXT,
      last_failure TEXT,
      failure_count INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1
    )
  `);
  
  // Load into memory
  const rows = db.prepare('SELECT * FROM agent_webhooks WHERE enabled = 1').all();
  for (const row of rows) {
    webhooks.set(row.agent_id, {
      ...row,
      events: JSON.parse(row.events)
    });
  }
  
  console.log(`🪝 Loaded ${webhooks.size} agent webhooks`);
}

/**
 * Register or update webhook for agent
 */
function register(agentId, url, events = ['mention', 'dm']) {
  const secret = crypto.randomBytes(32).toString('hex');
  const db = persistence.db;
  
  db.prepare(`
    INSERT INTO agent_webhooks (agent_id, url, secret, events)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      url = excluded.url,
      events = excluded.events,
      failure_count = 0,
      enabled = 1
  `).run(agentId, url, secret, JSON.stringify(events));
  
  webhooks.set(agentId, { agent_id: agentId, url, secret, events, enabled: 1 });
  
  console.log(`🪝 Registered webhook for ${agentId}: ${url}`);
  return { agentId, url, secret, events };
}

/**
 * Remove webhook for agent
 */
function unregister(agentId) {
  const db = persistence.db;
  db.prepare('DELETE FROM agent_webhooks WHERE agent_id = ?').run(agentId);
  webhooks.delete(agentId);
  console.log(`🪝 Unregistered webhook for ${agentId}`);
}

/**
 * Get webhook config for agent
 */
function getWebhook(agentId) {
  return webhooks.get(agentId);
}

/**
 * Extract @mentions from message content
 * Supports: @agentId, @agent_xyz, @AgentName
 */
function extractMentions(content) {
  const mentions = new Set();
  
  // Match @agent_xxxxx pattern
  const agentIdPattern = /@(agent_[a-f0-9]+)/gi;
  let match;
  while ((match = agentIdPattern.exec(content)) !== null) {
    mentions.add(match[1].toLowerCase());
  }
  
  // Match @Name pattern and resolve to agentId
  // TODO: Implement name -> agentId lookup
  
  return Array.from(mentions);
}

/**
 * Sign webhook payload
 */
function signPayload(payload, secret) {
  return 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Fire webhook to agent (async, non-blocking)
 */
async function fireWebhook(agentId, event, data) {
  const hook = webhooks.get(agentId);
  if (!hook || !hook.enabled) return;
  if (!hook.events.includes(event)) return;
  
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    deliveryId: `del_${crypto.randomBytes(8).toString('hex')}`,
    ...data
  };
  
  const signature = signPayload(payload, hook.secret);
  
  console.log(`🪝 Firing ${event} webhook to ${agentId}`);
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ClawSwarm-Signature': signature,
        'X-ClawSwarm-Event': event,
        'X-ClawSwarm-Delivery': payload.deliveryId,
        'User-Agent': 'ClawSwarm/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      // Update success timestamp
      const db = persistence.db;
      db.prepare(`
        UPDATE agent_webhooks 
        SET last_success = ?, failure_count = 0 
        WHERE agent_id = ?
      `).run(new Date().toISOString(), agentId);
      
      console.log(`🪝 ✓ Webhook delivered to ${agentId}`);
      return true;
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`🪝 ✗ Webhook failed for ${agentId}: ${err.message}`);
    
    // Update failure count
    const db = persistence.db;
    const result = db.prepare(`
      UPDATE agent_webhooks 
      SET last_failure = ?, failure_count = failure_count + 1
      WHERE agent_id = ?
    `).run(new Date().toISOString(), agentId);
    
    // Disable after 5 consecutive failures
    const updated = db.prepare('SELECT failure_count FROM agent_webhooks WHERE agent_id = ?').get(agentId);
    if (updated && updated.failure_count >= 5) {
      db.prepare('UPDATE agent_webhooks SET enabled = 0 WHERE agent_id = ?').run(agentId);
      webhooks.delete(agentId);
      console.log(`🪝 Disabled webhook for ${agentId} after 5 failures`);
    }
    
    return false;
  }
}

/**
 * Dispatch webhooks for a channel message
 * Called after message is posted to a channel
 */
async function dispatchForMessage(channelId, channelName, message, subscribers = []) {
  const mentions = extractMentions(message.content);
  
  // Combine mentions + subscribers, exclude author
  const toNotify = new Set([...mentions]);
  
  // Add subscribers who have 'channel_subscribed' event
  for (const sub of subscribers) {
    const hook = webhooks.get(sub);
    if (hook && hook.events.includes('channel_subscribed')) {
      toNotify.add(sub);
    }
  }
  
  // Don't notify the author
  toNotify.delete(message.agentId);
  
  if (toNotify.size === 0) return;
  
  console.log(`🪝 Dispatching webhooks to ${toNotify.size} agents`);
  
  // Fire all webhooks in parallel (don't await, fire-and-forget)
  const eventType = mentions.length > 0 ? 'mention' : 'channel_subscribed';
  
  for (const agentId of toNotify) {
    fireWebhook(agentId, mentions.includes(agentId) ? 'mention' : 'channel_subscribed', {
      channel: { id: channelId, name: channelName },
      message: {
        id: message.id,
        authorId: message.agentId,
        content: message.content,
        timestamp: message.timestamp
      },
      mentionedAgents: mentions
    }).catch(() => {}); // Ignore errors, already logged
  }
}

/**
 * List all registered webhooks (admin)
 */
function listAll() {
  return Array.from(webhooks.values()).map(h => ({
    agentId: h.agent_id,
    url: h.url,
    events: h.events,
    enabled: h.enabled,
    failureCount: h.failure_count
  }));
}

module.exports = {
  initialize,
  register,
  unregister,
  getWebhook,
  extractMentions,
  fireWebhook,
  dispatchForMessage,
  listAll
};
