/**
 * redis-streams.js - Redis Streams messaging for ClawSwarm
 * v1.0.0 - Real-time message delivery with persistence
 */

const Redis = require("ioredis");

// Connect to existing fly-redis container
const REDIS_URL = process.env.REDIS_URL || "redis://fly-redis:6379";
const redis = new Redis(REDIS_URL);
const subscriber = new Redis(REDIS_URL);

// Stream keys
const CHANNEL_STREAM = (channelId) => `stream:channel:${channelId}`;
const AGENT_INBOX = (agentId) => `stream:agent:${agentId}:inbox`;
const CONSUMER_GROUP = "clawswarm-consumers";

// Initialize consumer groups
async function initStreams(channelIds = [], agentIds = []) {
  for (const channelId of channelIds) {
    try {
      await redis.xgroup("CREATE", CHANNEL_STREAM(channelId), CONSUMER_GROUP, "$", "MKSTREAM");
      console.log(`📡 Created stream for channel: ${channelId}`);
    } catch (e) {
      if (!e.message.includes("BUSYGROUP")) throw e;
    }
  }
  for (const agentId of agentIds) {
    try {
      await redis.xgroup("CREATE", AGENT_INBOX(agentId), CONSUMER_GROUP, "$", "MKSTREAM");
      console.log(`📬 Created inbox for agent: ${agentId}`);
    } catch (e) {
      if (!e.message.includes("BUSYGROUP")) throw e;
    }
  }
}

// Publish message to channel stream
async function publishToChannel(channelId, message) {
  const streamKey = CHANNEL_STREAM(channelId);
  const msgData = {
    id: message.id,
    agentId: message.agentId,
    content: message.content,
    type: message.type || "text",
    metadata: JSON.stringify(message.metadata || {}),
    timestamp: message.timestamp || new Date().toISOString()
  };

  // Add to stream
  const entryId = await redis.xadd(streamKey, "*", ...Object.entries(msgData).flat());
  console.log(`📨 Published to ${streamKey}: ${entryId}`);
  return entryId;
}

// Send direct message to agent inbox
async function sendToAgent(agentId, message) {
  const streamKey = AGENT_INBOX(agentId);
  const msgData = {
    id: message.id,
    fromAgentId: message.fromAgentId,
    content: message.content,
    type: message.type || "direct",
    metadata: JSON.stringify(message.metadata || {}),
    timestamp: new Date().toISOString()
  };

  const entryId = await redis.xadd(streamKey, "*", ...Object.entries(msgData).flat());
  console.log(`📬 Sent to ${agentId}: ${entryId}`);
  return entryId;
}

// Read messages from channel (with blocking for real-time)
async function readChannel(channelId, consumerName, count = 10, blockMs = 0) {
  const streamKey = CHANNEL_STREAM(channelId);
  
  try {
    // Try to create consumer group if not exists
    await redis.xgroup("CREATE", streamKey, CONSUMER_GROUP, "$", "MKSTREAM").catch(() => {});
    
    const result = await redis.xreadgroup(
      "GROUP", CONSUMER_GROUP, consumerName,
      "COUNT", count,
      blockMs > 0 ? "BLOCK" : null,
      blockMs > 0 ? blockMs : null,
      "STREAMS", streamKey, ">"
    ).catch(() => null);

    if (!result) return [];

    return result[0][1].map(([id, fields]) => {
      const msg = {};
      for (let i = 0; i < fields.length; i += 2) {
        msg[fields[i]] = fields[i + 1];
      }
      msg.streamId = id;
      if (msg.metadata) msg.metadata = JSON.parse(msg.metadata);
      return msg;
    });
  } catch (e) {
    console.error("Read error:", e.message);
    return [];
  }
}

// Read agent inbox
async function readInbox(agentId, consumerName, count = 10, blockMs = 0) {
  const streamKey = AGENT_INBOX(agentId);
  
  try {
    await redis.xgroup("CREATE", streamKey, CONSUMER_GROUP, "$", "MKSTREAM").catch(() => {});
    
    const result = await redis.xreadgroup(
      "GROUP", CONSUMER_GROUP, consumerName,
      "COUNT", count,
      blockMs > 0 ? "BLOCK" : null,
      blockMs > 0 ? blockMs : null,
      "STREAMS", streamKey, ">"
    ).catch(() => null);

    if (!result) return [];

    return result[0][1].map(([id, fields]) => {
      const msg = {};
      for (let i = 0; i < fields.length; i += 2) {
        msg[fields[i]] = fields[i + 1];
      }
      msg.streamId = id;
      if (msg.metadata) msg.metadata = JSON.parse(msg.metadata);
      return msg;
    });
  } catch (e) {
    console.error("Read inbox error:", e.message);
    return [];
  }
}

// Acknowledge message processed
async function ackMessage(streamKey, messageId) {
  await redis.xack(streamKey, CONSUMER_GROUP, messageId);
}

// Get channel history (last N messages)
async function getChannelHistory(channelId, count = 50) {
  const streamKey = CHANNEL_STREAM(channelId);
  const result = await redis.xrevrange(streamKey, "+", "-", "COUNT", count);
  
  return result.map(([id, fields]) => {
    const msg = {};
    for (let i = 0; i < fields.length; i += 2) {
      msg[fields[i]] = fields[i + 1];
    }
    msg.streamId = id;
    if (msg.metadata) msg.metadata = JSON.parse(msg.metadata);
    return msg;
  }).reverse();
}

// Broadcast to multiple agents
async function broadcast(agentIds, message) {
  const promises = agentIds.map(agentId => sendToAgent(agentId, message));
  await Promise.all(promises);
  console.log(`📢 Broadcast to ${agentIds.length} agents`);
}

// Health check
async function healthCheck() {
  try {
    await redis.ping();
    return { status: "connected", url: REDIS_URL };
  } catch (e) {
    return { status: "disconnected", error: e.message };
  }
}

module.exports = {
  redis,
  initStreams,
  publishToChannel,
  sendToAgent,
  readChannel,
  readInbox,
  ackMessage,
  getChannelHistory,
  broadcast,
  healthCheck,
  CHANNEL_STREAM,
  AGENT_INBOX
};
