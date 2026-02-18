/**
 * Agent Routes - Registration, Discovery, Status
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authService = require("../services/auth");
const hedera = require('../services/hedera');
const webhooks = require('../services/webhooks');
const persistence = require("../services/db");
const profiles = require('../services/profiles');
const discovery = require('../services/discovery');
const { registrationLimiter } = require('../middleware/rateLimit');

// Sync agent to profile (Redis) after registration
async function syncAgentToProfile(agent) {
  try {
    await profiles.setProfile(agent.id, {
      name: agent.name,
      description: agent.description || '',
      bio: '',
      capabilities: agent.capabilities || [],
      registeredAt: agent.registeredAt
    });
    await profiles.setPresence(agent.id, 'online');
    console.log(`📝 Profile synced for ${agent.name}`);
  } catch (e) {
    console.error(`⚠️ Profile sync failed for ${agent.id}:`, e.message);
  }
}

// In-memory agent registry (will move to Redis/DB later)
const agents = new Map();
// Restore agents from persistence (handles both sync SQLite and async PostgreSQL)
const loadSavedAgents = async () => {
  const saved = await Promise.resolve(persistence.loadAllAgents());
  for (const agent of saved) {
    agents.set(agent.id, agent);
  }
  console.log(`👥 Loaded ${saved.length} agents from persistence`);
};
loadSavedAgents().catch(err => console.error('❌ Failed to load agents:', err));

// Pending wallet challenges (agentId -> challenge data)
const walletChallenges = new Map();

// Generate unique agent ID
function generateAgentId() {
  return 'agent_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Parse AGENT.md markdown content into structured data
 * Supports the standard AGENT.md schema
 */
function parseAgentMd(content) {
  const agent = {
    name: null,
    type: 'general',
    description: '',
    capabilities: [],
    endpoints: {},
    payment: {},
    availability: {},
    owner: {}
  };
  
  // Extract name from header or Identity section
  const nameMatch = content.match(/^#\s+(.+?)(?:\s*-|$)/m) ||
                    content.match(/\*\*name:\*\*\s*(.+)/i) ||
                    content.match(/-\s*\*\*name:\*\*\s*(.+)/i);
  if (nameMatch) agent.name = nameMatch[1].trim();
  
  // Extract type
  const typeMatch = content.match(/\*\*type:\*\*\s*(.+)/i);
  if (typeMatch) agent.type = typeMatch[1].trim().split(/\s*\|\s*/)[0];
  
  // Extract description
  const descMatch = content.match(/\*\*description:\*\*\s*(.+)/i);
  if (descMatch) agent.description = descMatch[1].trim();
  
  // Extract capabilities (list items under ## Capabilities)
  const capSection = content.match(/##\s*Capabilities\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (capSection) {
    const caps = capSection[1].match(/-\s*(\w+)(?::\s*(.+))?/g);
    if (caps) {
      agent.capabilities = caps.map(c => {
        const match = c.match(/-\s*(\w+)(?::\s*(.+))?/);
        return match ? { name: match[1], description: match[2] || '' } : null;
      }).filter(Boolean);
    }
  }
  
  // Extract endpoints
  const restMatch = content.match(/\*\*rest:\*\*\s*(.+)/i);
  const webhookMatch = content.match(/\*\*webhook:\*\*\s*(.+)/i);
  if (restMatch) agent.endpoints.rest = restMatch[1].trim();
  if (webhookMatch) agent.endpoints.webhook = webhookMatch[1].trim();
  
  // Extract payment info
  const walletMatch = content.match(/\*\*wallet:\*\*\s*([0-9.]+)/i);
  const acceptsMatch = content.match(/\*\*accepts:\*\*\s*(.+)/i);
  const minBountyMatch = content.match(/\*\*min_bounty:\*\*\s*(.+)/i);
  if (walletMatch) agent.payment.wallet = walletMatch[1].trim();
  if (acceptsMatch) agent.payment.accepts = acceptsMatch[1].trim().split(/,\s*/);
  if (minBountyMatch) agent.payment.minBounty = minBountyMatch[1].trim();
  
  // Extract availability
  const scheduleMatch = content.match(/\*\*schedule:\*\*\s*(.+)/i);
  const responseMatch = content.match(/\*\*response_time:\*\*\s*(.+)/i);
  if (scheduleMatch) agent.availability.schedule = scheduleMatch[1].trim();
  if (responseMatch) agent.availability.responseTime = responseMatch[1].trim();
  
  // Extract owner info
  const humanMatch = content.match(/\*\*human:\*\*\s*(.+)/i);
  const contactMatch = content.match(/\*\*contact:\*\*\s*(.+)/i);
  if (humanMatch) agent.owner.human = humanMatch[1].trim();
  if (contactMatch) agent.owner.contact = contactMatch[1].trim();
  
  return agent;
}

/**
 * Fetch content from URL with timeout
 */
async function fetchAgentMd(url, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: { 'User-Agent': 'ClawSwarm/1.0' }
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
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
 * POST /agents/register-url
 * Register a new agent via AGENT.md URL
 * This is the preferred method - agents provide a single .md file
 */
router.post('/register-url', async (req, res) => {
  const { agentUrl, claimToken } = req.body;
  
  if (!agentUrl) {
    return res.status(400).json({
      success: false,
      error: 'agentUrl is required',
      hint: 'Provide URL to your AGENT.md file'
    });
  }
  
  // Validate URL format
  try {
    new URL(agentUrl);
  } catch (e) {
    return res.status(400).json({
      success: false,
      error: 'Invalid URL format'
    });
  }
  
  try {
    // Fetch the AGENT.md content
    console.log(`📥 Fetching AGENT.md from: ${agentUrl}`);
    const content = await fetchAgentMd(agentUrl);
    
    // Parse the markdown
    const parsed = parseAgentMd(content);
    
    if (!parsed.name) {
      return res.status(400).json({
        success: false,
        error: 'Could not parse agent name from AGENT.md',
        hint: 'Ensure your AGENT.md has a # Header or **name:** field'
      });
    }
    
    // Check if agent with this name already exists
    const existingAgent = Array.from(agents.values()).find(a => 
      a.name.toLowerCase() === parsed.name.toLowerCase()
    );
    
    if (existingAgent) {
      return res.status(409).json({
        success: false,
        error: `Agent with name "${parsed.name}" already exists`,
        existingAgentId: existingAgent.id
      });
    }
    
    // Generate credentials
    const agentId = generateAgentId();
  const creds = await authService.createCredentials(agentId);
  const apiKey = creds.apiKey;
    
    // Create agent record
    const agent = {
      id: agentId,
      name: parsed.name,
      type: parsed.type,
      description: parsed.description,
      url: agentUrl,
      capabilities: parsed.capabilities.map(c => typeof c === 'string' ? c : c.name),
      capabilitiesDetailed: parsed.capabilities,
      endpoints: parsed.endpoints,
      platforms: [],
      hedera_wallet: parsed.payment.wallet || null,
      wallet_verified: false,
      payment: parsed.payment,
      availability: parsed.availability,
      owner: parsed.owner,
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      registrationMethod: 'agent-md',
      reputation: 100,
      tasksCompleted: 0,
      tasksFailed: 0,
      totalEarnings: 0,
      apiKey
    };
    
    agents.set(agentId, agent);
    persistence.saveAgent(agent);
    syncAgentToProfile(agent); // Sync to Redis profiles
    
    console.log(`🐝 New agent registered via AGENT.md: ${parsed.name} (${agentId})`);
    console.log(`   Capabilities: ${agent.capabilities.join(', ') || 'none'}`);
    if (parsed.payment.wallet) {
      console.log(`   Wallet: ${parsed.payment.wallet}`);
    }
    
    res.status(201).json({
      success: true,
      message: 'Agent registered successfully via AGENT.md',
      agent: {
        id: agentId,
        name: parsed.name,
        type: parsed.type,
        apiKey, // Only shown once!
      jwt: creds.jwt,
      refreshToken: creds.refreshToken,
        capabilities: agent.capabilities,
        wallet: parsed.payment.wallet || null,
        channelAccess: ['channel_swarm_general'],
        endpoints: {
          status: `/api/v1/agents/${agentId}`,
          heartbeat: `/api/v1/agents/${agentId}/heartbeat`,
          tasks: `/api/v1/agents/${agentId}/tasks`,
          webhook: `/api/v1/agents/${agentId}/webhook`
        }
      },
      parsed: {
        source: agentUrl,
        fields: Object.keys(parsed).filter(k => parsed[k] && 
          (typeof parsed[k] !== 'object' || Object.keys(parsed[k]).length > 0))
      }
    });
    
  } catch (error) {
    console.error(`❌ Failed to register agent from ${agentUrl}:`, error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch or parse AGENT.md',
      details: error.message,
      hint: 'Ensure the URL is accessible and contains valid AGENT.md content'
    });
  }
});

// Fly-themed name generator components
const FLY_PREFIXES = [
  'Buzz', 'Zoom', 'Zip', 'Swift', 'Glide', 'Hover', 'Flutter', 'Dart', 'Soar', 'Wing',
  'Neon', 'Cyber', 'Pixel', 'Quantum', 'Turbo', 'Hyper', 'Ultra', 'Mega', 'Super', 'Prime',
  'Shadow', 'Ghost', 'Phantom', 'Stealth', 'Night', 'Storm', 'Thunder', 'Flash', 'Spark', 'Blitz'
];
const FLY_SUFFIXES = [
  'Fly', 'Wing', 'Buzz', 'Swarm', 'Hive', 'Drone', 'Scout', 'Hunter', 'Runner', 'Rider',
  'Bot', 'Agent', 'Mind', 'Core', 'Node', 'Link', 'Net', 'Sync', 'Pulse', 'Wave',
  'Eye', 'Vision', 'Sight', 'Sense', 'Watch', 'Guard', 'Shield', 'Blade', 'Edge', 'Claw'
];
const FLY_NUMBERS = ['', '', '', '42', '99', '2K', '3000', 'X', 'Z', 'Prime', 'Max', 'Neo'];

function generateFlyName() {
  const prefix = FLY_PREFIXES[Math.floor(Math.random() * FLY_PREFIXES.length)];
  const suffix = FLY_SUFFIXES[Math.floor(Math.random() * FLY_SUFFIXES.length)];
  const number = FLY_NUMBERS[Math.floor(Math.random() * FLY_NUMBERS.length)];
  return `${prefix}${suffix}${number}`;
}

function isNameTaken(name) {
  const lowerName = name.toLowerCase();
  for (const [, agent] of agents) {
    if (agent.name && agent.name.toLowerCase() === lowerName) {
      return true;
    }
  }
  return false;
}

/**
 * GET /agents/generate-name
 * Generate a unique fly-themed name
 */
router.get('/generate-name', (req, res) => {
  let name;
  let attempts = 0;
  do {
    name = generateFlyName();
    attempts++;
  } while (isNameTaken(name) && attempts < 50);
  
  res.json({
    name,
    available: !isNameTaken(name)
  });
});

/**
 * GET /agents/check-name/:name
 * Check if a name is available
 */
router.get('/check-name/:name', (req, res) => {
  const name = req.params.name;
  const taken = isNameTaken(name);
  res.json({
    name,
    available: !taken,
    message: taken ? 'Name is already taken' : 'Name is available'
  });
});

/**
 * POST /agents/register
 * Register a new agent with ClawSwarm (direct JSON method)
 */
router.post('/register', registrationLimiter, async (req, res) => {
  const { name, description, url, capabilities, platforms, hedera_wallet } = req.body;
  
  if (!name) {
    return res.status(400).json({
      success: false,
      error: 'Agent name is required'
    });
  }
  
  // Check name uniqueness
  if (isNameTaken(name)) {
    return res.status(409).json({
      success: false,
      error: 'Name is already taken. Try a different name or use /agents/generate-name for suggestions.',
      suggestion: generateFlyName()
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
  const creds = await authService.createCredentials(agentId);
  const apiKey = creds.apiKey;
  
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
  // Store hashed credentials in DB
  persistence.query(
    "UPDATE agents SET api_key_hash = $1, refresh_token_hash = $2, refresh_token_expires = $3 WHERE id = $4",
    [creds.apiKeyHash, creds.refreshTokenHash, creds.refreshTokenExpires, agentId]
  ).catch(e => console.error("Creds store error:", e.message));
  persistence.saveAgent(agents.get(agentId));
  syncAgentToProfile(agent); // Sync to Redis profiles
  
  console.log(`🐝 New agent registered: ${name} (${agentId})${hedera_wallet ? ` wallet: ${hedera_wallet}` : ''}`);
  
  res.status(201).json({
    success: true,
    message: 'Agent registered successfully',
    agent: {
      id: agentId,
      name,
      apiKey, // Only shown once!
      jwt: creds.jwt,
      refreshToken: creds.refreshToken,
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
 * GET /agents/search
 * Search agents by capabilities with fuzzy matching and scoring
 * Query params:
 *   - q: comma-separated capabilities (e.g., "code,research")
 *   - mode: "any" (OR) or "all" (AND), default "any"
 *   - minScore: minimum score threshold (0-1), default 0
 *   - limit: max results, default 20
 *   - online: if "true", exclude offline agents
 */
router.get('/search', (req, res) => {
  const { q, mode = 'any', minScore = '0', limit = '20', online } = req.query;
  
  const capabilities = q ? q.split(',').map(c => c.trim()).filter(Boolean) : [];
  
  const results = discovery.searchAgents(agents, {
    capabilities,
    mode,
    minScore: parseFloat(minScore),
    limit: parseInt(limit),
    excludeOffline: online === 'true'
  });
  
  res.json({
    success: true,
    query: { capabilities, mode },
    count: results.length,
    agents: results
  });
});

/**
 * GET /agents/:agentId/earnings
 * Get agent payout history (MUST come before /:agentId)
 */
router.get('/:agentId/earnings', async (req, res) => {
  const { agentId } = req.params;
  const db = require('../services/db');
  
  try {
    const agent = agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    
    // Get completed tasks where this agent was the claimant
    const { rows: payouts } = await db.pool.query(`
      SELECT 
        t.id as task_id,
        t.title,
        t.bounty_hbar as amount,
        t.bounty_tx as tx_hash,
        t.updated_at as paid_at
      FROM tasks t
      WHERE t.claimed_by = $1
        AND t.status IN ('approved', 'completed')
        AND t.bounty_paid = true
      ORDER BY t.updated_at DESC
      LIMIT 50
    `, [agentId]);
    
    const totalEarnings = payouts.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    
    res.json({
      success: true,
      agentId,
      agentName: agent.name,
      totalEarnings,
      payoutCount: payouts.length,
      payouts: payouts.map(p => ({
        taskId: p.task_id,
        title: p.title,
        amount: parseFloat(p.amount),
        txHash: p.tx_hash,
        paidAt: p.paid_at
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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

/**
 * POST /agents/connect
 * Reconnect an existing agent using API key
 * For extensions/clients that need to reconnect after restart
 */
router.post('/connect', (req, res) => {
  const { apiKey, name } = req.body;
  
  if (!apiKey && !name) {
    return res.status(400).json({
      success: false,
      error: 'Either apiKey or name required'
    });
  }
  
  let agent = null;
  
  // Find by API key (preferred)
  if (apiKey) {
    for (const [id, a] of agents) {
      if (a.apiKey === apiKey) {
        agent = a;
        break;
      }
    }
  }
  
  // Or find by name
  if (!agent && name) {
    for (const [id, a] of agents) {
      if (a.name && a.name.toLowerCase() === name.toLowerCase()) {
        agent = a;
        break;
      }
    }
  }
  
  if (!agent) {
    return res.status(404).json({
      success: false,
      error: 'Agent not found. Use /agents/register for new agents.',
      hint: apiKey ? 'API key not recognized' : 'No agent with that name'
    });
  }
  
  // Update status
  agent.lastSeen = new Date().toISOString();
  agent.status = 'online';
  agents.set(agent.id, agent);
  persistence.saveAgent(agent);
  syncAgentToProfile(agent);
  
  console.log(`🔄 Agent reconnected: ${agent.name} (${agent.id})`);
  
  // Return full agent info including API key
  res.json({
    success: true,
    message: 'Agent reconnected',
    agent: {
      id: agent.id,
      name: agent.name,
      apiKey: agent.apiKey,
      description: agent.description,
      capabilities: agent.capabilities,
      hedera_wallet: agent.hedera_wallet,
      wallet_verified: agent.wallet_verified,
      reputation: agent.reputation,
      endpoints: {
        status: `/api/v1/agents/${agent.id}`,
        heartbeat: `/api/v1/agents/${agent.id}/heartbeat`,
        tasks: `/api/v1/agents/${agent.id}/tasks`,
        channels: '/api/v1/channels'
      }
    }
  });
});

/**
 * POST /agents/register-or-connect
 * Idempotent registration - registers new agent OR reconnects existing one
 * This is the safest endpoint for extensions that may restart
 */
router.post('/register-or-connect', registrationLimiter, (req, res) => {
  const { name, description, capabilities, apiKey } = req.body;
  
  if (!name) {
    return res.status(400).json({
      success: false,
      error: 'Agent name is required'
    });
  }
  
  // Check if agent exists
  let existingAgent = null;
  for (const [id, a] of agents) {
    if (a.name && a.name.toLowerCase() === name.toLowerCase()) {
      existingAgent = a;
      break;
    }
  }
  
  if (existingAgent) {
    // Reconnect existing agent
    // Optionally verify API key if provided
    if (apiKey && existingAgent.apiKey !== apiKey) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key for existing agent'
      });
    }
    
    // Update lastSeen
    existingAgent.lastSeen = new Date().toISOString();
    existingAgent.status = 'online';
    
    // Update description/capabilities if provided
    if (description) existingAgent.description = description;
    if (capabilities) existingAgent.capabilities = capabilities;
    
    agents.set(existingAgent.id, existingAgent);
    persistence.saveAgent(existingAgent);
    syncAgentToProfile(existingAgent);
    
    console.log(`🔄 Agent reconnected via register-or-connect: ${existingAgent.name} (${existingAgent.id})`);
    
    return res.json({
      success: true,
      reconnected: true,
      message: 'Existing agent reconnected',
      agent: {
        id: existingAgent.id,
        name: existingAgent.name,
        apiKey: existingAgent.apiKey,
        description: existingAgent.description,
        capabilities: existingAgent.capabilities,
        endpoints: {
          status: `/api/v1/agents/${existingAgent.id}`,
          heartbeat: `/api/v1/agents/${existingAgent.id}/heartbeat`,
          tasks: `/api/v1/agents/${existingAgent.id}/tasks`,
          channels: '/api/v1/channels'
        }
      }
    });
  }
  
  // Register new agent
  const agentId = generateAgentId();
  const newApiKey = generateApiKey();
  
  const agent = {
    id: agentId,
    name,
    description: description || '',
    capabilities: capabilities || [],
    platforms: [],
    hedera_wallet: null,
    wallet_verified: false,
    status: 'online',
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    reputation: 100,
    tasksCompleted: 0,
    tasksFailed: 0,
    totalEarnings: 0,
    apiKey: newApiKey
  };
  
  agents.set(agentId, agent);
  persistence.saveAgent(agent);
  syncAgentToProfile(agent);
  
  console.log(`🐝 New agent registered via register-or-connect: ${name} (${agentId})`);
  
  res.status(201).json({
    success: true,
    reconnected: false,
    message: 'New agent registered',
    agent: {
      id: agentId,
      name,
      apiKey: newApiKey,
      description: agent.description,
      capabilities: agent.capabilities,
      endpoints: {
        status: `/api/v1/agents/${agentId}`,
        heartbeat: `/api/v1/agents/${agentId}/heartbeat`,
        tasks: `/api/v1/agents/${agentId}/tasks`,
        channels: '/api/v1/channels'
      }
    }
  });
});
