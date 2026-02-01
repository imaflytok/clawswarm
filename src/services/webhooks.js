/**
 * Webhook Service - Real-time notifications for agents
 * v0.7.0
 */

const https = require("https");
const http = require("http");

// Registered webhooks: agentId -> { url, secret, events[], failures, lastSuccess }
const webhooks = new Map();

// Retry config
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 15000]; // Exponential backoff

/**
 * Register a webhook for an agent
 */
function register(agentId, url, secret = null, events = ["message", "task", "channel"]) {
  if (!url || !url.startsWith("http")) {
    throw new Error("Invalid webhook URL");
  }
  
  webhooks.set(agentId, {
    url,
    secret,
    events,
    failures: 0,
    lastSuccess: null,
    registeredAt: new Date().toISOString()
  });
  
  console.log(`🔔 Webhook registered for ${agentId}: ${url}`);
  return true;
}

/**
 * Unregister webhook
 */
function unregister(agentId) {
  return webhooks.delete(agentId);
}

/**
 * Get webhook config for agent
 */
function get(agentId) {
  return webhooks.get(agentId);
}

/**
 * Send webhook notification
 */
async function send(agentId, event, payload, retryCount = 0) {
  const webhook = webhooks.get(agentId);
  if (!webhook) return false;
  
  // Check if subscribed to this event type
  if (!webhook.events.includes(event) && !webhook.events.includes("*")) {
    return false;
  }
  
  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    payload
  });
  
  const urlObj = new URL(webhook.url);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "X-ClawSwarm-Event": event,
      "X-ClawSwarm-Agent": agentId
    },
    timeout: 5000
  };
  
  // Add HMAC signature if secret configured
  if (webhook.secret) {
    const crypto = require("crypto");
    const signature = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
    options.headers["X-ClawSwarm-Signature"] = signature;
  }
  
  return new Promise((resolve) => {
    const protocol = urlObj.protocol === "https:" ? https : http;
    
    const req = protocol.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        webhook.failures = 0;
        webhook.lastSuccess = new Date().toISOString();
        console.log(`✅ Webhook delivered to ${agentId}: ${event}`);
        resolve(true);
      } else {
        handleFailure(agentId, event, payload, retryCount, `HTTP ${res.statusCode}`);
        resolve(false);
      }
    });
    
    req.on("error", (err) => {
      handleFailure(agentId, event, payload, retryCount, err.message);
      resolve(false);
    });
    
    req.on("timeout", () => {
      req.destroy();
      handleFailure(agentId, event, payload, retryCount, "Timeout");
      resolve(false);
    });
    
    req.write(body);
    req.end();
  });
}

/**
 * Handle webhook failure with retry
 */
function handleFailure(agentId, event, payload, retryCount, reason) {
  const webhook = webhooks.get(agentId);
  if (!webhook) return;
  
  webhook.failures++;
  console.warn(`⚠️ Webhook failed for ${agentId}: ${reason} (attempt ${retryCount + 1})`);
  
  // Retry with backoff
  if (retryCount < MAX_RETRIES) {
    const delay = RETRY_DELAYS[retryCount] || 15000;
    setTimeout(() => {
      send(agentId, event, payload, retryCount + 1);
    }, delay);
  } else {
    console.error(`❌ Webhook exhausted retries for ${agentId}`);
    // Disable after 10 consecutive failures
    if (webhook.failures >= 10) {
      console.error(`🔇 Webhook disabled for ${agentId} (too many failures)`);
      webhook.events = []; // Effectively disabled
    }
  }
}

/**
 * Broadcast to multiple agents (e.g., channel members)
 */
async function broadcast(agentIds, event, payload) {
  const results = await Promise.all(
    agentIds.map(id => send(id, event, payload))
  );
  return results.filter(Boolean).length;
}

/**
 * Get all registered webhooks (for status)
 */
function list() {
  const result = [];
  webhooks.forEach((config, agentId) => {
    result.push({
      agentId,
      url: config.url.replace(/^(https?:\/\/[^\/]+).*/, "$1/..."), // Mask path
      events: config.events,
      failures: config.failures,
      lastSuccess: config.lastSuccess
    });
  });
  return result;
}

module.exports = {
  register,
  unregister,
  get,
  send,
  broadcast,
  list
};
