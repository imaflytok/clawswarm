/**
 * channels.js - Channel management with Redis Streams
 * v1.0.0 - Real-time messaging via Redis + SQLite backup
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const persistence = require("../services/db");
const streams = require("../services/redis-streams");
const webhooks = require("../services/webhooks");
const { messageLimiter } = require("../middleware/rateLimit");

// In-memory channel registry (loaded from persistence)
const channels = new Map();

// Load saved channels on startup (handles both sync SQLite and async PostgreSQL)
async function initialize() {
  const savedChannels = await Promise.resolve(persistence.loadAllChannels());
  for (const ch of savedChannels) {
    channels.set(ch.id, ch);
    console.log(`📡 Loaded channel: ${ch.id} (${ch.name})`);
  }
  
  // Initialize Redis streams for all channels
  const channelIds = Array.from(channels.keys());
  if (channelIds.length > 0) {
    await streams.initStreams(channelIds, []);
    console.log(`📡 Initialized ${channelIds.length} Redis streams`);
  }
}
initialize().catch(console.error);

// List all channels
router.get("/", (req, res) => {
  res.json({
    channels: Array.from(channels.values()).map(ch => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      members: ch.members?.length || 0,
      createdAt: ch.createdAt
    }))
  });
});

// Create channel
router.post("/", async (req, res) => {
  const { name, type = "public" } = req.body;
  if (!name) return res.status(400).json({ error: "Channel name required" });

  const id = `channel_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
  
  if (channels.has(id)) {
    return res.status(409).json({ error: "Channel already exists", id });
  }

  const channel = {
    id,
    name,
    type,
    members: [],
    createdAt: new Date().toISOString()
  };

  channels.set(id, channel);
  persistence.saveChannel(channel);
  
  // Initialize Redis stream
  await streams.initStreams([id], []);

  console.log(`📡 Channel created: ${id}`);
  res.status(201).json(channel);
});

// Get channel info
router.get("/:channelId", (req, res) => {
  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  res.json(channel);
});

// Join channel
router.post("/:channelId/join", (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId required" });

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  if (!channel.members) channel.members = [];
  if (!channel.members.includes(agentId)) {
    channel.members.push(agentId);
    persistence.saveChannel(channel);
    console.log(`👋 ${agentId} joined ${channel.name}`);
  }

  res.json({ joined: req.params.channelId, members: channel.members });
});

// Leave channel
router.post("/:channelId/leave", (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId required" });

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  if (channel.members) {
    channel.members = channel.members.filter(id => id !== agentId);
    persistence.saveChannel(channel);
    console.log(`👋 ${agentId} left ${channel.name}`);
  }

  res.json({ left: req.params.channelId });
});

// Post message to channel - NOW USES REDIS STREAMS
router.post("/:channelId/message", messageLimiter, async (req, res) => {
  const { agentId, content, type = "text", metadata = {} } = req.body;
  if (!agentId || !content) {
    return res.status(400).json({ error: "agentId and content required" });
  }

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  const message = {
    id: `msg_${uuidv4().slice(0, 8)}`,
    agentId,
    content,
    type,
    metadata,
    timestamp: new Date().toISOString()
  };

  // Publish to Redis Stream (real-time)
  try {
    await streams.publishToChannel(req.params.channelId, message);
  } catch (e) {
    console.error("Redis publish failed:", e.message);
    // Fall back to SQLite only
  }
  
  // Also save to SQLite (persistence backup)
  try { persistence.saveMessage(req.params.channelId, message); } catch (e) { console.log("SQLite backup skipped:", e.message); }

  // Get channel members for delivery info
  const recipients = channel.members?.filter(id => id !== agentId) || [];

  // Dispatch webhooks to mentioned agents and subscribers (async, non-blocking)
  webhooks.dispatchForMessage(req.params.channelId, channel.name, message, channel.members || [])
    .catch(err => console.error('Webhook dispatch error:', err.message));

  console.log(`💬 [${channel.name}] ${agentId}: ${content.substring(0, 50)}...`);
  res.status(201).json({ message, recipients });
});

// Get channel messages - HYBRID: Redis first, SQLite fallback
router.get("/:channelId/messages", async (req, res) => {
  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  const limit = parseInt(req.query.limit) || 50;
  const since = req.query.since;

  let messages = [];
  
  // Try Redis Stream history first
  try {
    messages = await streams.getChannelHistory(req.params.channelId, limit);
  } catch (e) {
    console.error("Redis history failed:", e.message);
  }
  
  // Fallback to SQLite if Redis empty
  if (messages.length === 0) {
    messages = persistence.loadMessages(req.params.channelId, limit);
  }

  // Filter by since if provided
  if (since) {
    messages = messages.filter(m => new Date(m.timestamp) > new Date(since));
  }

  res.json({ channelId: req.params.channelId, messages });
});

// SSE endpoint for real-time messages
router.get("/:channelId/stream", async (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param required" });

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  console.log(`🔴 SSE stream opened: ${agentId} -> ${channel.name}`);

  // Poll Redis stream for new messages
  const consumerName = `${agentId}-${Date.now()}`;
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const messages = await streams.readChannel(
          req.params.channelId, 
          consumerName, 
          10, 
          5000  // 5 second block
        );
        for (const msg of messages) {
          if (msg.agentId !== agentId) {  // Dont echo own messages
            res.write(`data: ${JSON.stringify(msg)}\n\n`);
          }
          // Acknowledge
          await streams.ackMessage(
            streams.CHANNEL_STREAM(req.params.channelId), 
            msg.streamId
          );
        }
      } catch (e) {
        if (running) console.error("SSE poll error:", e.message);
      }
    }
  };

  poll();

  req.on("close", () => {
    running = false;
    console.log(`🔴 SSE stream closed: ${agentId}`);
  });
});

// Redis Streams health endpoint
router.get("/_health/redis", async (req, res) => {
  const health = await streams.healthCheck();
  res.json(health);
});

// ============================================
// PHASE 2: Per-Agent Reliable Messaging
// ============================================

/**
 * POST /:channelId/subscribe
 * Subscribe an agent to a channel with their own consumer group
 * This enables reliable message delivery - agents won't miss messages
 */
router.post("/:channelId/subscribe", async (req, res) => {
  const { agentId, startFrom = "$" } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId required" });

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    const result = await streams.subscribeAgent(req.params.channelId, agentId, startFrom);
    
    // Also add to channel members if not already
    if (!channel.members) channel.members = [];
    if (!channel.members.includes(agentId)) {
      channel.members.push(agentId);
      persistence.saveChannel(channel);
    }
    
    res.json({
      success: true,
      channelId: req.params.channelId,
      agentId,
      ...result,
      hint: startFrom === "0" ? "Will receive all historical messages" : "Will receive only new messages"
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /:channelId/unsubscribe
 * Unsubscribe an agent from a channel
 */
router.post("/:channelId/unsubscribe", async (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId required" });

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    const result = await streams.unsubscribeAgent(req.params.channelId, agentId);
    
    // Also remove from channel members
    if (channel.members) {
      channel.members = channel.members.filter(id => id !== agentId);
      persistence.saveChannel(channel);
    }
    
    res.json({ success: true, channelId: req.params.channelId, agentId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /:channelId/read/:agentId
 * Read new (unread) messages for a specific agent
 * Uses agent's own consumer group - messages are marked as delivered
 */
router.get("/:channelId/read/:agentId", async (req, res) => {
  const { agentId } = req.params;
  const count = parseInt(req.query.count) || 50;
  const block = parseInt(req.query.block) || 0;

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    const messages = await streams.readForAgent(req.params.channelId, agentId, count, block);
    
    res.json({
      channelId: req.params.channelId,
      agentId,
      count: messages.length,
      messages,
      hint: messages.length > 0 ? "Remember to ACK messages after processing" : "No new messages"
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /:channelId/pending/:agentId
 * Get pending (delivered but unacknowledged) messages for an agent
 * Use this to catch up after being offline
 */
router.get("/:channelId/pending/:agentId", async (req, res) => {
  const { agentId } = req.params;
  const count = parseInt(req.query.count) || 100;

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    const result = await streams.getPendingForAgent(req.params.channelId, agentId, count);
    
    res.json({
      channelId: req.params.channelId,
      agentId,
      ...result,
      hint: result.count > 0 ? "These messages were delivered but not acknowledged - process and ACK them" : "No pending messages"
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /:channelId/ack
 * Acknowledge message(s) as processed by an agent
 */
router.post("/:channelId/ack", async (req, res) => {
  const { agentId, messageId, messageIds } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId required" });
  if (!messageId && !messageIds) return res.status(400).json({ error: "messageId or messageIds required" });

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    let acked = 0;
    
    if (messageIds && Array.isArray(messageIds)) {
      acked = await streams.ackBatchForAgent(req.params.channelId, agentId, messageIds);
    } else if (messageId) {
      const result = await streams.ackForAgent(req.params.channelId, agentId, messageId);
      acked = result ? 1 : 0;
    }
    
    res.json({
      success: true,
      channelId: req.params.channelId,
      agentId,
      acknowledged: acked
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /:channelId/status/:agentId
 * Get agent's subscription status for a channel
 */
router.get("/:channelId/status/:agentId", async (req, res) => {
  const { agentId } = req.params;

  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    const status = await streams.getAgentStatus(req.params.channelId, agentId);
    
    res.json({
      channelId: req.params.channelId,
      agentId,
      ...status
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /:channelId/subscribers
 * List all agents subscribed to a channel (with their pending counts)
 */
router.get("/:channelId/subscribers", async (req, res) => {
  const channel = channels.get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  try {
    const subscribers = await streams.getChannelSubscribers(req.params.channelId);
    
    res.json({
      channelId: req.params.channelId,
      count: subscribers.length,
      subscribers
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
