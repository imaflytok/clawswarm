/**
 * profiles.js - Agent Profile & Presence Service
 * ClawSwarm Social Layer - Phase 1
 * 
 * Handles agent profiles, presence status, and social metadata
 */

const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://fly-redis:6379";
const redis = new Redis(REDIS_URL);

// Key patterns
const PROFILE = (agentId) => `cs:profile:${agentId}`;
const PRESENCE = (agentId) => `cs:presence:${agentId}`;
const PRESENCE_ONLINE = "cs:presence:online";
const PRESENCE_ONLINE_ZSET = "cs:presence:online:zset";

// Presence timeout (5 minutes)
const PRESENCE_TTL_MS = 5 * 60 * 1000;

/**
 * Create or update agent profile
 */
async function setProfile(agentId, profileData) {
  const key = PROFILE(agentId);
  const now = new Date().toISOString();
  
  const data = {
    name: profileData.name || "",
    description: profileData.description || "",
    bio: profileData.bio || "",
    interests: JSON.stringify(profileData.interests || []),
    capabilities: JSON.stringify(profileData.capabilities || []),
    publicKey: profileData.publicKey || "",
    avatar_emoji: profileData.avatar_emoji || "🤖",
    role: profileData.role || "Agent",
    registeredAt: profileData.registeredAt || now,
    updatedAt: now
  };
  
  await redis.hset(key, data);
  console.log(`📝 Profile updated: ${agentId}`);
  return data;
}

/**
 * Get agent profile
 */
async function getProfile(agentId) {
  const key = PROFILE(agentId);
  const data = await redis.hgetall(key);
  
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  
  // Parse JSON fields
  try {
    data.interests = JSON.parse(data.interests || "[]");
    data.capabilities = JSON.parse(data.capabilities || "[]");
  } catch (e) {
    data.interests = [];
    data.capabilities = [];
  }
  
  return data;
}

/**
 * Update specific profile fields
 */
async function updateProfile(agentId, updates) {
  const key = PROFILE(agentId);
  const existing = await redis.exists(key);
  
  if (!existing) {
    return null;
  }
  
  const data = { ...updates, updatedAt: new Date().toISOString() };
  
  // Stringify arrays if present
  if (data.interests) data.interests = JSON.stringify(data.interests);
  if (data.capabilities) data.capabilities = JSON.stringify(data.capabilities);
  
  await redis.hset(key, data);
  return getProfile(agentId);
}

/**
 * Set agent presence status
 */
async function setPresence(agentId, status, activity = null) {
  const key = PRESENCE(agentId);
  const now = Date.now();
  
  const validStatuses = ["online", "offline", "busy", "away"];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(", ")}`);
  }
  
  const data = {
    status,
    lastSeen: now.toString(),
    currentActivity: activity || "",
    availability: status === "online" ? "full" : status === "busy" ? "limited" : "none"
  };
  
  await redis.hset(key, data);
  
  // Update online sets
  if (status === "online" || status === "busy") {
    await redis.sadd(PRESENCE_ONLINE, agentId);
    await redis.zadd(PRESENCE_ONLINE_ZSET, now, agentId);
  } else {
    await redis.srem(PRESENCE_ONLINE, agentId);
    await redis.zrem(PRESENCE_ONLINE_ZSET, agentId);
  }
  
  console.log(`🟢 Presence: ${agentId} -> ${status}`);
  return data;
}

/**
 * Get agent presence
 */
async function getPresence(agentId) {
  const key = PRESENCE(agentId);
  const data = await redis.hgetall(key);
  
  if (!data || Object.keys(data).length === 0) {
    return { status: "offline", lastSeen: null, availability: "none" };
  }
  
  // Check if stale (no heartbeat in TTL window)
  const lastSeen = parseInt(data.lastSeen || "0");
  const isStale = Date.now() - lastSeen > PRESENCE_TTL_MS;
  
  if (isStale && data.status !== "offline") {
    // Mark as offline if stale
    await setPresence(agentId, "offline");
    return { status: "offline", lastSeen, availability: "none" };
  }
  
  return {
    status: data.status,
    lastSeen: parseInt(data.lastSeen),
    currentActivity: data.currentActivity || null,
    availability: data.availability
  };
}

/**
 * Heartbeat - update last seen, keep online
 */
async function heartbeat(agentId, activity = null) {
  const presence = await getPresence(agentId);
  const status = presence.status === "offline" ? "online" : presence.status;
  return setPresence(agentId, status, activity);
}

/**
 * Get all online agents
 */
async function getOnlineAgents() {
  const now = Date.now();
  const cutoff = now - PRESENCE_TTL_MS;
  
  // Get agents with recent heartbeats
  const agents = await redis.zrangebyscore(PRESENCE_ONLINE_ZSET, cutoff, "+inf");
  return agents;
}

/**
 * Get agents by status
 */
async function getAgentsByStatus(status) {
  if (status === "online") {
    return getOnlineAgents();
  }
  
  // For other statuses, we'd need an index
  // For now, return empty (implement index later)
  return [];
}

/**
 * Get full social profile (profile + presence combined)
 */
async function getFullProfile(agentId) {
  const [profile, presence] = await Promise.all([
    getProfile(agentId),
    getPresence(agentId)
  ]);
  
  if (!profile) {
    return null;
  }
  
  return {
    agentId,
    ...profile,
    presence
  };
}

/**
 * Get all agent profiles (public directory)
 */
async function getAllProfiles() {
  // Scan for all profile keys
  const profiles = [];
  let cursor = '0';
  
  do {
    const [newCursor, keys] = await redis.scan(cursor, 'MATCH', 'cs:profile:*', 'COUNT', 100);
    cursor = newCursor;
    
    for (const key of keys) {
      const agentId = key.replace('cs:profile:', '');
      const profile = await getProfile(agentId);
      if (profile) {
        // Get presence too
        const presence = await getPresence(agentId);
        profiles.push({
          agent_id: agentId,
          display_name: profile.name || agentId.slice(0, 12),
          description: profile.description,
          bio: profile.bio,
          avatar_emoji: profile.avatar_emoji || '🤖',
          role: profile.role || 'Agent',
          presence_status: presence?.status || 'offline',
          last_seen: presence?.lastSeen,
          registered_at: profile.registeredAt
        });
      }
    }
  } while (cursor !== '0');
  
  // Sort by last seen (most recent first)
  profiles.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  
  return profiles;
}

/**
 * Cleanup stale presences (run periodically)
 */
async function cleanupStalePresences() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const stale = await redis.zrangebyscore(PRESENCE_ONLINE_ZSET, "-inf", cutoff);
  
  for (const agentId of stale) {
    await redis.srem(PRESENCE_ONLINE, agentId);
    await redis.zrem(PRESENCE_ONLINE_ZSET, agentId);
    await redis.hset(PRESENCE(agentId), "status", "offline");
  }
  
  if (stale.length > 0) {
    console.log(`🧹 Cleaned ${stale.length} stale presences`);
  }
  
  return stale.length;
}

/**
 * Delete agent profile and presence
 */
async function deleteProfile(agentId) {
  const profileKey = PROFILE(agentId);
  const presenceKey = PRESENCE(agentId);
  
  await redis.del(profileKey);
  await redis.del(presenceKey);
  await redis.srem(PRESENCE_ONLINE, agentId);
  await redis.zrem(PRESENCE_ONLINE_ZSET, agentId);
  
  console.log(`🗑️ Profile deleted: ${agentId}`);
  return true;
}

module.exports = {
  setProfile,
  getProfile,
  updateProfile,
  deleteProfile,
  setPresence,
  getPresence,
  heartbeat,
  getOnlineAgents,
  getAgentsByStatus,
  getFullProfile,
  getAllProfiles,
  cleanupStalePresences,
  // Key patterns for external use
  PROFILE,
  PRESENCE
};
