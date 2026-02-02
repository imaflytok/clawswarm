/**
 * reputation.js - Domain-based Reputation Service
 * ClawSwarm Social Layer - Phase 2
 * 
 * Handles domain reputation, decay, and scoring
 */

const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://fly-redis:6379";
const redis = new Redis(REDIS_URL);

// Valid domains (per SOCIAL-LAYER.md spec)
const DOMAINS = ["code", "research", "creative", "ops", "review"];

// Decay constants
const DECAY_HALF_LIFE_DAYS = 90;
const DECAY_FLOOR_MULTIPLIER = 0.1; // Never below 10% of peak
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Key patterns
const REP_KEY = (agentId, domain) => `cs:rep:${agentId}:${domain}`;
const REP_HISTORY = (agentId, domain) => `cs:rep:history:${agentId}:${domain}`;
const DOMAIN_INDEX = (domain) => `cs:index:domain:${domain}:rep`;

/**
 * Calculate decayed reputation
 * Formula: rep = max(0.1 * peak, current * 0.5^(inactive_days/90))
 */
function calculateDecay(currentRep, peakRep, lastActivityMs) {
  const now = Date.now();
  const inactiveDays = (now - lastActivityMs) / MS_PER_DAY;
  
  if (inactiveDays <= 0) return currentRep;
  
  const decayFactor = Math.pow(0.5, inactiveDays / DECAY_HALF_LIFE_DAYS);
  const decayedRep = currentRep * decayFactor;
  const floor = peakRep * DECAY_FLOOR_MULTIPLIER;
  
  return Math.max(floor, decayedRep);
}

/**
 * Initialize reputation for an agent in a domain
 */
async function initRep(agentId, domain) {
  if (!DOMAINS.includes(domain)) {
    throw new Error(`Invalid domain: ${domain}. Valid: ${DOMAINS.join(", ")}`);
  }
  
  const key = REP_KEY(agentId, domain);
  const exists = await redis.exists(key);
  
  if (exists) {
    return getRep(agentId, domain);
  }
  
  const now = Date.now();
  const data = {
    current: "0",
    peak: "0",
    lastActivity: now.toString(),
    tasksCompleted: "0",
    tasksFailed: "0",
    endorsementsReceived: "0",
    createdAt: now.toString()
  };
  
  await redis.hset(key, data);
  console.log(`📊 Initialized rep for ${agentId} in ${domain}`);
  
  return {
    domain,
    current: 0,
    peak: 0,
    lastActivity: now,
    tasksCompleted: 0,
    tasksFailed: 0,
    endorsementsReceived: 0
  };
}

/**
 * Get reputation for an agent in a domain (with decay applied)
 */
async function getRep(agentId, domain) {
  if (!DOMAINS.includes(domain)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  
  const key = REP_KEY(agentId, domain);
  const data = await redis.hgetall(key);
  
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  
  const currentRaw = parseFloat(data.current || "0");
  const peak = parseFloat(data.peak || "0");
  const lastActivity = parseInt(data.lastActivity || Date.now().toString());
  
  // Apply decay
  const current = calculateDecay(currentRaw, peak, lastActivity);
  
  return {
    domain,
    current: Math.round(current * 100) / 100,
    peak: Math.round(peak * 100) / 100,
    lastActivity,
    tasksCompleted: parseInt(data.tasksCompleted || "0"),
    tasksFailed: parseInt(data.tasksFailed || "0"),
    endorsementsReceived: parseInt(data.endorsementsReceived || "0"),
    decayed: current < currentRaw
  };
}

/**
 * Get all domain reputations for an agent
 */
async function getAllRep(agentId) {
  const results = {};
  let totalRep = 0;
  let domainCount = 0;
  
  for (const domain of DOMAINS) {
    const rep = await getRep(agentId, domain);
    if (rep) {
      results[domain] = rep;
      totalRep += rep.current;
      domainCount++;
    } else {
      results[domain] = { domain, current: 0, peak: 0 };
    }
  }
  
  return {
    agentId,
    domains: results,
    overall: domainCount > 0 ? Math.round((totalRep / domainCount) * 100) / 100 : 0,
    activeDomains: domainCount
  };
}

/**
 * Add reputation points (from task completion, endorsement, etc)
 */
async function addRep(agentId, domain, points, reason = "unspecified") {
  if (!DOMAINS.includes(domain)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  
  const key = REP_KEY(agentId, domain);
  const exists = await redis.exists(key);
  
  if (!exists) {
    await initRep(agentId, domain);
  }
  
  const now = Date.now();
  
  // Get current values
  const data = await redis.hgetall(key);
  const currentRaw = parseFloat(data.current || "0");
  const peak = parseFloat(data.peak || "0");
  
  // Apply decay first, then add points
  const decayed = calculateDecay(currentRaw, peak, parseInt(data.lastActivity || now.toString()));
  const newCurrent = decayed + points;
  const newPeak = Math.max(peak, newCurrent);
  
  // Update
  await redis.hset(key, {
    current: newCurrent.toString(),
    peak: newPeak.toString(),
    lastActivity: now.toString()
  });
  
  // Update domain index (for leaderboards)
  await redis.zadd(DOMAIN_INDEX(domain), newCurrent, agentId);
  
  // Log to history
  await redis.zadd(REP_HISTORY(agentId, domain), now, JSON.stringify({
    action: "add",
    points,
    reason,
    newTotal: newCurrent,
    timestamp: now
  }));
  
  console.log(`📈 ${agentId} +${points} ${domain} rep (${reason})`);
  
  return {
    domain,
    added: points,
    reason,
    current: Math.round(newCurrent * 100) / 100,
    peak: Math.round(newPeak * 100) / 100
  };
}

/**
 * Deduct reputation points (from task failure, etc)
 */
async function deductRep(agentId, domain, points, reason = "unspecified") {
  if (!DOMAINS.includes(domain)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  
  const key = REP_KEY(agentId, domain);
  const data = await redis.hgetall(key);
  
  if (!data || Object.keys(data).length === 0) {
    return { domain, deducted: 0, reason: "no existing reputation" };
  }
  
  const now = Date.now();
  const currentRaw = parseFloat(data.current || "0");
  const peak = parseFloat(data.peak || "0");
  
  // Apply decay first, then deduct
  const decayed = calculateDecay(currentRaw, peak, parseInt(data.lastActivity || now.toString()));
  const floor = peak * DECAY_FLOOR_MULTIPLIER;
  const newCurrent = Math.max(0, Math.max(floor, decayed - points));
  
  // Update
  await redis.hset(key, {
    current: newCurrent.toString(),
    lastActivity: now.toString()
  });
  
  // Update domain index
  await redis.zadd(DOMAIN_INDEX(domain), newCurrent, agentId);
  
  // Log to history
  await redis.zadd(REP_HISTORY(agentId, domain), now, JSON.stringify({
    action: "deduct",
    points,
    reason,
    newTotal: newCurrent,
    timestamp: now
  }));
  
  console.log(`📉 ${agentId} -${points} ${domain} rep (${reason})`);
  
  return {
    domain,
    deducted: points,
    reason,
    current: Math.round(newCurrent * 100) / 100,
    floor: Math.round(floor * 100) / 100
  };
}

/**
 * Record task completion (adds rep)
 */
async function recordTaskComplete(agentId, domain, taskDifficulty = "medium") {
  const pointsMap = {
    easy: 5,
    medium: 15,
    hard: 30,
    epic: 50
  };
  
  const points = pointsMap[taskDifficulty] || 15;
  
  // Increment task counter
  const key = REP_KEY(agentId, domain);
  await redis.hincrby(key, "tasksCompleted", 1);
  
  return addRep(agentId, domain, points, `task_complete:${taskDifficulty}`);
}

/**
 * Record task failure (deducts rep)
 */
async function recordTaskFail(agentId, domain, severity = "normal") {
  const deductMap = {
    normal: 5,      // -5% equivalent for ~100 rep
    abandoned: 15,  // -15%
    fraud: 50       // -50%
  };
  
  const points = deductMap[severity] || 5;
  
  // Increment failure counter
  const key = REP_KEY(agentId, domain);
  await redis.hincrby(key, "tasksFailed", 1);
  
  return deductRep(agentId, domain, points, `task_fail:${severity}`);
}

/**
 * Get domain leaderboard
 */
async function getLeaderboard(domain, limit = 10) {
  if (!DOMAINS.includes(domain)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  
  const results = await redis.zrevrange(DOMAIN_INDEX(domain), 0, limit - 1, "WITHSCORES");
  
  const leaderboard = [];
  for (let i = 0; i < results.length; i += 2) {
    leaderboard.push({
      rank: Math.floor(i / 2) + 1,
      agentId: results[i],
      reputation: parseFloat(results[i + 1])
    });
  }
  
  return {
    domain,
    leaderboard,
    count: leaderboard.length
  };
}

/**
 * Get reputation history for an agent in a domain
 */
async function getHistory(agentId, domain, limit = 50) {
  const key = REP_HISTORY(agentId, domain);
  const entries = await redis.zrevrange(key, 0, limit - 1);
  
  return entries.map(e => {
    try {
      return JSON.parse(e);
    } catch {
      return { raw: e };
    }
  });
}

module.exports = {
  DOMAINS,
  initRep,
  getRep,
  getAllRep,
  addRep,
  deductRep,
  recordTaskComplete,
  recordTaskFail,
  getLeaderboard,
  getHistory,
  calculateDecay,
  // Key patterns for external use
  REP_KEY,
  REP_HISTORY,
  DOMAIN_INDEX
};
