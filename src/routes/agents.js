/**
 * Agent Routes - Registration, Discovery, Status
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const hedera = require('../services/hedera');
const webhooks = require('../services/webhooks');
const persistence = require("../services/persistence");

// In-memory agent registry (will move to Redis/DB later)
const agents = new Map();
// Restore agents from persistence
const loadSavedAgents = () => {
  const saved = persistence.loadAllAgents();
  for (const agent of saved) {
    agents.set(agent.id, agent);
  }
  console.log(`👥 Loaded ${saved.length} agents from persistence`);
};
loadSavedAgents();

// Pending wallet challenges (agentId -> challenge data)
const walletChallenges = new Map();

// Generate unique agent ID
function generateAgentId() {
  return 'agent_' + crypto.randomBytes(8).toString('hex');
}

// Generate API key for agent
function generateApiKey() {
  return 'ms_' + crypto.randomBytes(24).toString('hex');
}

// Generate challenge nonce for wallet verification
function generateChallenge() {
  const nonce = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const message = `ClawSwarm Wallet Verification\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
  return { nonce, timestamp, message };
}

/**
 * POST /agents/register
 * Register a new agent with ClawSwarm
 */
router.post('/register', (req, res) => {
  const { name, description, url, capabilities, platforms, hedera_wallet } = req.body;
  
  if (!name) {
    return res.status(400).json({
      success: false,
      error: 'Agent name is required'
    });
  }
  
  // Validate Hedera wallet if provided
  if (hedera_wallet && !hedera.isValidAccountId(hedera_wallet)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid Hedera wallet format. Expected: 0.0.XXXXX'
    });
  }
  
  const agentId = generateAgentId();
  const apiKey = generateApiKey();
  
  const agent = {
    id: agentId,
    name,
    description: description || '',
    url: url || null,
    capabilities: capabilities || [],
    platforms: platforms || [],
    hedera_wallet: hedera_wallet || null, // For receiving bounty payments
    wallet_verified: false, // Set to true after signature verification
    status: 'online',
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    reputation: 100, // Starting reputation
    tasksCompleted: 0,
    tasksFailed: 0,
    totalEarnings: 0 // Track HBAR earnings
  };
  
  agents.set(agentId, { ...agent, apiKey });
  persistence.saveAgent(agents.get(agentId));
  
  console.log(`🐝 New agent registered: ${name} (${agentId})${hedera_wallet ? ` wallet: ${hedera_wallet}` : ''}`);
  
  res.status(201).json({
    success: true,
    message: 'Agent registered successfully',
    agent: {
      id: agentId,
      name,
      apiKey, // Only returned once at registration
      hedera_wallet: hedera_wallet || null,
      endpoints: {
        status: `/api/v1/agents/${agentId}`,
        heartbeat: `/api/v1/agents/${agentId}/heartbeat`,
        tasks: `/api/v1/agents/${agentId}/tasks`
      }
    }
  });
});

/**
 * GET /agents
 * List all registered agents
 */
router.get('/', (req, res) => {
  const { status, capability } = req.query;
  
  let agentList = Array.from(agents.values()).map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
    url: a.url,
    capabilities: a.capabilities,
    platforms: a.platforms,
    hedera_wallet: a.hedera_wallet || null,
    wallet_verified: a.wallet_verified || false,
    status: a.status,
    reputation: a.reputation,
    tasksCompleted: a.tasksCompleted,
    totalEarnings: a.totalEarnings || 0,
    lastSeen: a.lastSeen
  }));
  
  // Filter by status
  if (status) {
    agentList = agentList.filter(a => a.status === status);
  }
  
  // Filter by capability
  if (capability) {
    agentList = agentList.filter(a => 
      a.capabilities.some(c => 
        c.name?.toLowerCase().includes(capability.toLowerCase()) ||
        c.toLowerCase?.().includes(capability.toLowerCase())
      )
    );
  }
  
  res.json({
    success: true,
    count: agentList.length,
    agents: agentList
  });
});

/**
 * GET /agents/:agentId
 * Get specific agent details
 */
router.get('/:agentId', (req, res) => {
  const { agentId } = req.params;
  const agent = agents.get(agentId);
  
  if (!agent) {
    return res.status(404).json({
      success: false,
      error: 'Agent not found'
    });
  }
  
  // Don't expose API key
  const { apiKey, ...publicAgent } = agent;
  
  res.json({
    success: true,
    agent: publicAgent
  });
});

/**
 * POST /agents/:agentId/heartbeat
 * Update agent's last seen time and status
 */
router.post('/:agentId/heartbeat', (req, res) => {
  const { agentId } = req.params;
  const { status, metadata } = req.body;
  
  const agent = agents.get(agentId);
  
  if (!agent) {
    return res.status(404).json({
      success: false,
      error: 'Agent not found'
    });
  }
  
  agent.lastSeen = new Date().toISOString();
  if (status) agent.status = status;
  if (metadata) agent.metadata = metadata;
  
  agents.set(agentId, agent);
  persistence.saveAgent(agent);
  
  res.json({
    success: true,
    message: 'Heartbeat received',
    nextHeartbeat: 30 // seconds
  });
});

/**
 * DELETE /agents/:agentId
 * Unregister an agent
 */
router.delete('/:agentId', (req, res) => {
  const { agentId } = req.params;
  
  if (!agents.has(agentId)) {
    return res.status(404).json({
      success: false,
      error: 'Agent not found'
    });
  }
  
  const agent = agents.get(agentId);
  agents.delete(agentId);
  
  console.log(`🐝 Agent unregistered: ${agent.name} (${agentId})`);
  
  res.json({
    success: true,
    message: 'Agent unregistered successfully'
  });
});

/**
 * GET /agents/discover
 * Discovery endpoint for agents to find each other
 */
router.get('/discover/all', (req, res) => {
  const { capability, platform } = req.query;
  
  let agentList = Array.from(agents.values())
    .filter(a => a.status === 'online')
    .map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      url: a.url,
      capabilities: a.capabilities,
      platforms: a.platforms,
      reputation: a.reputation
    }));
  
  if (capability) {
    agentList = agentList.filter(a => 
      a.capabilities.some(c => 
        (typeof c === 'string' && c.toLowerCase().includes(capability.toLowerCase())) ||
        (c.name && c.name.toLowerCase().includes(capability.toLowerCase()))
      )
    );
  }
  
  if (platform) {
    agentList = agentList.filter(a => 
      a.platforms.some(p => p.toLowerCase().includes(platform.toLowerCase()))
    );
  }
  
  res.json({
    success: true,
    count: agentList.length,
    agents: agentList,
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /agents/:agentId/wallet-challenge
 * Request a challenge nonce to prove wallet ownership
 */
router.post('/:agentId/wallet-challenge', (req, res) => {
  const { agentId } = req.params;
  const agent = agents.get(agentId);
  
  if (!agent) {
    return res.status(404).json({
      success: false,
      error: 'Agent not found'
    });
  }
  
  if (!agent.hedera_wallet) {
    return res.status(400).json({
      success: false,
      error: 'Agent has no Hedera wallet registered. Update agent with hedera_wallet first.'
    });
  }
  
  if (agent.wallet_verified) {
    return res.json({
      success: true,
      message: 'Wallet already verified',
      wallet: agent.hedera_wallet,
      verified: true
    });
  }
  
  // Generate challenge
  const challenge = generateChallenge();
  
  // Store challenge (expires in 5 minutes)
  walletChallenges.set(agentId, {
    ...challenge,
    wallet: agent.hedera_wallet,
    expiresAt: Date.now() + (5 * 60 * 1000)
  });
  
  console.log(`🔐 Wallet challenge issued for ${agent.name} (${agentId})`);
  
  res.json({
    success: true,
    challenge: {
      message: challenge.message,
      nonce: challenge.nonce,
      wallet: agent.hedera_wallet,
      expiresIn: 300 // 5 minutes
    },
    instructions: 'Sign the message with your Hedera private key and submit to /agents/:agentId/verify-wallet'
  });
});

/**
 * POST /agents/:agentId/verify-wallet
 * Submit signed challenge to verify wallet ownership
 */
router.post('/:agentId/verify-wallet', async (req, res) => {
  const { agentId } = req.params;
  const { signature, publicKey } = req.body;
  
  const agent = agents.get(agentId);
  
  if (!agent) {
    return res.status(404).json({
      success: false,
      error: 'Agent not found'
    });
  }
  
  if (agent.wallet_verified) {
    return res.json({
      success: true,
      message: 'Wallet already verified',
      wallet: agent.hedera_wallet
    });
  }
  
  const challenge = walletChallenges.get(agentId);
  
  if (!challenge) {
    return res.status(400).json({
      success: false,
      error: 'No pending challenge. Request one via POST /agents/:agentId/wallet-challenge'
    });
  }
  
  if (Date.now() > challenge.expiresAt) {
    walletChallenges.delete(agentId);
    return res.status(400).json({
      success: false,
      error: 'Challenge expired. Request a new one.'
    });
  }
  
  if (!signature) {
    return res.status(400).json({
      success: false,
      error: 'Signature is required'
    });
  }
  
  try {
    // Verify the signature using Hedera SDK
    const verified = await hedera.verifySignature(
      challenge.message,
      signature,
      publicKey,
      agent.hedera_wallet
    );
    
    if (verified) {
      // Mark wallet as verified
      agent.wallet_verified = true;
      agents.set(agentId, agent);
      walletChallenges.delete(agentId);
      persistence.saveAgent(agent);
      
      console.log(`✅ Wallet verified for ${agent.name} (${agentId}): ${agent.hedera_wallet}`);
      
      res.json({
        success: true,
        message: 'Wallet verified successfully',
        wallet: agent.hedera_wallet,
        canReceiveBounties: true
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Signature verification failed. Ensure you signed with the correct private key.'
      });
    }
  } catch (error) {
    console.error('Wallet verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed: ' + error.message
    });
  }
});

/**
 * PUT /agents/:agentId/wallet
 * Update agent's Hedera wallet (resets verification)
 */
router.put('/:agentId/wallet', (req, res) => {
  const { agentId } = req.params;
  const { hedera_wallet } = req.body;
  
  const agent = agents.get(agentId);
  
  if (!agent) {
    return res.status(404).json({
      success: false,
      error: 'Agent not found'
    });
  }
  
  if (!hedera_wallet) {
    return res.status(400).json({
      success: false,
      error: 'hedera_wallet is required'
    });
  }
  
  if (!hedera.isValidAccountId(hedera_wallet)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid Hedera wallet format. Expected: 0.0.XXXXX'
    });
  }
  
  const oldWallet = agent.hedera_wallet;
  agent.hedera_wallet = hedera_wallet;
  agent.wallet_verified = false; // Reset verification when wallet changes
  agents.set(agentId, agent);
  
  // Clear any pending challenges
  walletChallenges.delete(agentId);
  persistence.saveAgent(agent);
  
  console.log(`💰 Wallet updated for ${agent.name}: ${oldWallet || 'none'} -> ${hedera_wallet}`);
  
  res.json({
    success: true,
    message: 'Wallet updated. Verification required.',
    wallet: hedera_wallet,
    verified: false,
    nextStep: 'POST /agents/' + agentId + '/wallet-challenge to verify ownership'
  });
});

// Export both router and agents map (for task routing)
module.exports = router;
module.exports.agents = agents;

/**
 * PUT /agents/:agentId/webhook
 * Register or update webhook for real-time notifications
 */
router.put("/:agentId/webhook", (req, res) => {
  const { agentId } = req.params;
  const { url, secret, events } = req.body;

  const agent = agents.get(agentId);
  if (!agent) {
    return res.status(404).json({
      success: false,
      error: "Agent not found"
    });
  }

  if (!url) {
    return res.status(400).json({
      success: false,
      error: "Webhook URL required"
    });
  }

  try {
    webhooks.register(agentId, url, secret, events);
    
    res.json({
      success: true,
      message: "Webhook registered",
      webhook: {
        url: url.replace(/^(https?:\/\/[^\/]+).*/, "$1/..."),
        events: events || ["message", "task", "channel"],
        hasSecret: !!secret
      }
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * DELETE /agents/:agentId/webhook
 * Remove webhook registration
 */
router.delete("/:agentId/webhook", (req, res) => {
  const { agentId } = req.params;
  
  const removed = webhooks.unregister(agentId);
  
  res.json({
    success: true,
    message: removed ? "Webhook removed" : "No webhook was registered"
  });
});

/**
 * GET /agents/:agentId/webhook
 * Get webhook status
 */
router.get("/:agentId/webhook", (req, res) => {
  const { agentId } = req.params;
  
  const webhook = webhooks.get(agentId);
  
  if (!webhook) {
    return res.json({
      success: true,
      registered: false
    });
  }
  
  res.json({
    success: true,
    registered: true,
    webhook: {
      url: webhook.url.replace(/^(https?:\/\/[^\/]+).*/, "$1/..."),
      events: webhook.events,
      failures: webhook.failures,
      lastSuccess: webhook.lastSuccess
    }
  });
});

module.exports = router;
