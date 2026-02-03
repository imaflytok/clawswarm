/**
 * Governance API Routes
 * REST endpoints for ClawSwarm governance
 */

const express = require('express');
const router = express.Router();
const config = require('./config');
const staking = require('./services/staking');
const proposals = require('./services/proposals');

// Initialize on load
(async () => {
  await staking.initialize();
  await proposals.initialize();
  console.log('🏛️ Governance module initialized');
})();

// ============ Info Routes ============

/**
 * GET /governance
 * Get governance overview
 */
router.get('/', (req, res) => {
  const stats = staking.getStats();
  const activeProposals = proposals.listProposals({ status: 'voting' });
  
  res.json({
    name: 'ClawSwarm Governance',
    token: config.token,
    stats: {
      ...stats,
      activeProposals: activeProposals.length
    },
    tiers: {
      tier1: { name: config.tier1.name, maxBounty: config.tier1.maxBounty },
      tier2: { name: config.tier2.name, maxBounty: config.tier2.maxBounty },
      tier3: { name: config.tier3.name, description: 'High-stakes and parameter changes' }
    }
  });
});

/**
 * GET /governance/config
 * Get governance configuration
 */
router.get('/config', (req, res) => {
  res.json({
    token: config.token,
    staking: config.staking,
    tiers: { tier1: config.tier1, tier2: config.tier2, tier3: config.tier3 },
    sybil: config.sybil,
    rewards: config.rewards
  });
});

// ============ Staking Routes ============

/**
 * GET /governance/staking/stats
 * Get staking statistics
 */
router.get('/staking/stats', (req, res) => {
  res.json(staking.getStats());
});

/**
 * GET /governance/staking/:wallet
 * Get stake info for a wallet
 */
router.get('/staking/:wallet', async (req, res) => {
  const stake = await staking.getStakeByWallet(req.params.wallet);
  if (!stake) {
    return res.status(404).json({ error: 'No stake found for wallet' });
  }
  
  const votingPower = staking.getVotingPower(req.params.wallet);
  res.json({
    wallet: req.params.wallet,
    ...stake,
    votingPower
  });
});

/**
 * POST /governance/staking/link
 * Link wallet to Telegram account
 */
router.post('/staking/link', async (req, res) => {
  const { walletAddress, telegramId, phoneHash } = req.body;
  
  if (!walletAddress || !telegramId) {
    return res.status(400).json({ error: 'walletAddress and telegramId required' });
  }

  try {
    const result = await staking.linkWallet(walletAddress, telegramId, phoneHash);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /governance/staking/record
 * Record a stake (after verifying on-chain)
 */
router.post('/staking/record', async (req, res) => {
  const { walletAddress, amount } = req.body;
  
  if (!walletAddress || !amount) {
    return res.status(400).json({ error: 'walletAddress and amount required' });
  }

  try {
    const result = await staking.recordStake(walletAddress, amount);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /governance/staking/unstake
 * Request unstake
 */
router.post('/staking/unstake', async (req, res) => {
  const { walletAddress, amount } = req.body;
  
  if (!walletAddress || !amount) {
    return res.status(400).json({ error: 'walletAddress and amount required' });
  }

  try {
    const result = await staking.requestUnstake(walletAddress, amount);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============ Proposal Routes ============

/**
 * GET /governance/proposals
 * List proposals
 */
router.get('/proposals', (req, res) => {
  const { status, tier, limit } = req.query;
  const list = proposals.listProposals({ 
    status, 
    tier, 
    limit: limit ? parseInt(limit) : 20 
  });
  
  res.json({
    count: list.length,
    proposals: list
  });
});

/**
 * GET /governance/proposals/:id
 * Get proposal details
 */
router.get('/proposals/:id', (req, res) => {
  const proposal = proposals.getProposal(req.params.id);
  if (!proposal) {
    return res.status(404).json({ error: 'Proposal not found' });
  }
  
  const voteList = proposals.getVotes(req.params.id);
  res.json({
    ...proposal,
    votes: voteList,
    voteCount: voteList.length
  });
});

/**
 * POST /governance/proposals
 * Create a new proposal
 */
router.post('/proposals', async (req, res) => {
  const { 
    title, 
    description, 
    targetId, 
    targetType, 
    bountyHbar,
    creatorWallet,
    creatorTelegram
  } = req.body;
  
  if (!title || !creatorWallet) {
    return res.status(400).json({ error: 'title and creatorWallet required' });
  }

  try {
    const proposal = await proposals.createProposal({
      title,
      description,
      targetId,
      targetType,
      bountyHbar: bountyHbar || 0,
      creatorWallet,
      creatorTelegram
    });
    
    res.status(201).json(proposal);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============ Voting Routes ============

/**
 * POST /governance/proposals/:id/vote
 * Cast a vote (Tier 1 direct, or after reveal for Tier 2/3)
 */
router.post('/proposals/:id/vote', async (req, res) => {
  const { walletAddress, vote, telegramId } = req.body;
  
  if (!walletAddress || !vote) {
    return res.status(400).json({ error: 'walletAddress and vote required' });
  }

  try {
    const result = await proposals.vote(req.params.id, walletAddress, vote, telegramId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /governance/proposals/:id/commit
 * Commit a vote (Tier 2/3)
 */
router.post('/proposals/:id/commit', async (req, res) => {
  const { walletAddress, commitment, telegramId } = req.body;
  
  if (!walletAddress || !commitment) {
    return res.status(400).json({ error: 'walletAddress and commitment required' });
  }

  try {
    const result = await proposals.commitVote(req.params.id, walletAddress, commitment, telegramId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /governance/proposals/:id/reveal
 * Reveal a vote (Tier 2/3)
 */
router.post('/proposals/:id/reveal', async (req, res) => {
  const { walletAddress, vote, salt } = req.body;
  
  if (!walletAddress || !vote || !salt) {
    return res.status(400).json({ error: 'walletAddress, vote, and salt required' });
  }

  try {
    const result = await proposals.revealVote(req.params.id, walletAddress, vote, salt);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
