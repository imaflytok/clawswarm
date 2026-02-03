/**
 * Proposals Service
 * Governance proposals and voting for ClawSwarm
 */

const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const staking = require('./staking');
const db = require('../../services/db');

// In-memory cache
const proposals = new Map();  // proposalId -> proposal
const votes = new Map();       // proposalId -> Map(wallet -> vote)
const commitments = new Map(); // proposalId -> Map(wallet -> commitment)

/**
 * Initialize proposals tables
 */
async function initialize() {
  const client = db.getClient();
  if (!client) {
    console.log('⚠️ Proposals: No DB client, using in-memory only');
    return;
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS governance_proposals (
        id VARCHAR(50) PRIMARY KEY,
        tier VARCHAR(20) NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        target_id VARCHAR(50),
        target_type VARCHAR(20),
        bounty_hbar DECIMAL(20,8),
        creator_wallet VARCHAR(20) NOT NULL,
        creator_telegram VARCHAR(50),
        status VARCHAR(20) DEFAULT 'active',
        snapshot_time TIMESTAMP,
        voting_starts TIMESTAMP,
        voting_ends TIMESTAMP,
        reveal_ends TIMESTAMP,
        quorum_required DECIMAL(10,4),
        approval_required DECIMAL(10,4),
        total_votes BIGINT DEFAULT 0,
        approve_votes BIGINT DEFAULT 0,
        deny_votes BIGINT DEFAULT 0,
        abstain_votes BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS governance_votes (
        id SERIAL PRIMARY KEY,
        proposal_id VARCHAR(50) NOT NULL,
        wallet_address VARCHAR(20) NOT NULL,
        telegram_id VARCHAR(50),
        vote VARCHAR(10),
        voting_power BIGINT,
        commitment VARCHAR(66),
        salt VARCHAR(66),
        revealed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        revealed_at TIMESTAMP,
        UNIQUE(proposal_id, wallet_address)
      );
      
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON governance_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_votes_proposal ON governance_votes(proposal_id);
    `);
    console.log('✅ Proposals tables initialized');

    // Load active proposals
    const result = await client.query(
      "SELECT * FROM governance_proposals WHERE status IN ('active', 'voting', 'revealing')"
    );
    for (const row of result.rows) {
      proposals.set(row.id, rowToProposal(row));
    }
    console.log(`📊 Loaded ${proposals.size} active proposals`);
  } catch (e) {
    console.error('Proposals init error:', e.message);
  }
}

/**
 * Create a new proposal
 */
async function createProposal({
  title,
  description,
  targetId,
  targetType = 'task',
  bountyHbar = 0,
  creatorWallet,
  creatorTelegram
}) {
  // Determine tier based on bounty
  let tier, tierConfig;
  if (bountyHbar <= config.tier1.maxBounty) {
    tier = 'tier1';
    tierConfig = config.tier1;
    
    // Check proposer reputation for Tier 1
    // TODO: Integrate with ClawSwarm reputation
    // For now, allow any staker
  } else if (bountyHbar <= config.tier2.maxBounty) {
    tier = 'tier2';
    tierConfig = config.tier2;
    
    // Check proposer stake
    const stake = await staking.getStakeByWallet(creatorWallet);
    if (!stake || stake.amount < tierConfig.proposerStake) {
      throw new Error(`Tier 2 requires ${tierConfig.proposerStake} $FLY staked. You have: ${stake?.amount || 0}`);
    }
  } else {
    tier = 'tier3';
    tierConfig = config.tier3;
    
    // Check proposer stake
    const stake = await staking.getStakeByWallet(creatorWallet);
    if (!stake || stake.amount < tierConfig.proposerStake) {
      throw new Error(`Tier 3 requires ${tierConfig.proposerStake} $FLY staked. You have: ${stake?.amount || 0}`);
    }
  }

  const now = Date.now();
  const id = `prop_${uuidv4().slice(0, 8)}`;
  
  const proposal = {
    id,
    tier,
    title,
    description,
    targetId,
    targetType,
    bountyHbar,
    creatorWallet,
    creatorTelegram,
    status: 'active',
    snapshotTime: new Date(now + tierConfig.snapshotDelay),
    votingStarts: new Date(now + tierConfig.snapshotDelay),
    votingEnds: new Date(now + tierConfig.snapshotDelay + tierConfig.votingWindow),
    revealEnds: tierConfig.commitReveal 
      ? new Date(now + tierConfig.snapshotDelay + tierConfig.votingWindow + tierConfig.revealWindow)
      : null,
    quorumRequired: tierConfig.quorum,
    approvalRequired: tierConfig.approval,
    commitReveal: tierConfig.commitReveal,
    totalVotes: 0,
    approveVotes: 0,
    denyVotes: 0,
    abstainVotes: 0,
    createdAt: new Date()
  };

  // Save to DB
  const client = db.getClient();
  if (client) {
    await client.query(`
      INSERT INTO governance_proposals 
      (id, tier, title, description, target_id, target_type, bounty_hbar, 
       creator_wallet, creator_telegram, status, snapshot_time, voting_starts, 
       voting_ends, reveal_ends, quorum_required, approval_required)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `, [
      id, tier, title, description, targetId, targetType, bountyHbar,
      creatorWallet, creatorTelegram, 'active', proposal.snapshotTime,
      proposal.votingStarts, proposal.votingEnds, proposal.revealEnds,
      tierConfig.quorum, tierConfig.approval
    ]);
  }

  proposals.set(id, proposal);
  votes.set(id, new Map());
  if (tierConfig.commitReveal) {
    commitments.set(id, new Map());
  }

  // Schedule status transitions
  scheduleProposalTransitions(proposal);

  console.log(`📋 Proposal created: ${id} (${tier}) - ${title}`);
  return proposal;
}

/**
 * Cast a vote (Tier 1 - direct, Tier 2/3 - commit phase)
 */
async function vote(proposalId, walletAddress, voteChoice, telegramId = null) {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  
  // Check voting window
  const now = Date.now();
  if (now < proposal.votingStarts.getTime()) {
    throw new Error('Voting has not started yet');
  }
  if (now > proposal.votingEnds.getTime()) {
    throw new Error('Voting has ended');
  }

  // Check voting power
  const votingPower = staking.getVotingPower(walletAddress);
  if (votingPower <= 0) {
    throw new Error('No voting power. Stake $FLY and wait 7 days to vote.');
  }

  // Check if already voted
  const proposalVotes = votes.get(proposalId);
  if (proposalVotes.has(walletAddress)) {
    throw new Error('Already voted on this proposal');
  }

  // Validate vote choice
  if (!['approve', 'deny', 'abstain'].includes(voteChoice)) {
    throw new Error('Invalid vote. Choose: approve, deny, or abstain');
  }

  // For Tier 1 (no commit-reveal), record vote directly
  if (!proposal.commitReveal) {
    return recordVote(proposalId, walletAddress, voteChoice, votingPower, telegramId);
  }

  // For Tier 2/3, this should be a commitment (handled by commitVote)
  throw new Error('This proposal requires commit-reveal voting. Use /commit first.');
}

/**
 * Record a vote (internal, after reveal or for Tier 1)
 */
async function recordVote(proposalId, walletAddress, voteChoice, votingPower, telegramId = null) {
  const proposal = proposals.get(proposalId);
  const proposalVotes = votes.get(proposalId);

  proposalVotes.set(walletAddress, {
    vote: voteChoice,
    votingPower,
    telegramId,
    votedAt: new Date()
  });

  // Update proposal tallies
  proposal.totalVotes += votingPower;
  if (voteChoice === 'approve') proposal.approveVotes += votingPower;
  else if (voteChoice === 'deny') proposal.denyVotes += votingPower;
  else proposal.abstainVotes += votingPower;

  // Save to DB
  const client = db.getClient();
  if (client) {
    await client.query(`
      INSERT INTO governance_votes (proposal_id, wallet_address, telegram_id, vote, voting_power, revealed)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      ON CONFLICT (proposal_id, wallet_address) 
      DO UPDATE SET vote = $4, voting_power = $5, revealed = TRUE, revealed_at = NOW()
    `, [proposalId, walletAddress, telegramId, voteChoice, votingPower]);

    await client.query(`
      UPDATE governance_proposals 
      SET total_votes = $1, approve_votes = $2, deny_votes = $3, abstain_votes = $4
      WHERE id = $5
    `, [proposal.totalVotes, proposal.approveVotes, proposal.denyVotes, proposal.abstainVotes, proposalId]);
  }

  console.log(`🗳️ Vote recorded: ${walletAddress} -> ${voteChoice} (${votingPower} power)`);
  
  return {
    success: true,
    proposalId,
    vote: voteChoice,
    votingPower,
    totalVotes: proposal.totalVotes
  };
}

/**
 * Commit a vote (Tier 2/3 - commit phase)
 */
async function commitVote(proposalId, walletAddress, commitment, telegramId = null) {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (!proposal.commitReveal) throw new Error('This proposal does not use commit-reveal');

  const now = Date.now();
  if (now < proposal.votingStarts.getTime()) throw new Error('Voting has not started');
  if (now > proposal.votingEnds.getTime()) throw new Error('Commit phase has ended');

  const votingPower = staking.getVotingPower(walletAddress);
  if (votingPower <= 0) throw new Error('No voting power');

  const proposalCommits = commitments.get(proposalId);
  if (proposalCommits.has(walletAddress)) throw new Error('Already committed');

  proposalCommits.set(walletAddress, {
    commitment,
    votingPower,
    telegramId,
    committedAt: new Date()
  });

  // Save to DB
  const client = db.getClient();
  if (client) {
    await client.query(`
      INSERT INTO governance_votes (proposal_id, wallet_address, telegram_id, commitment, voting_power)
      VALUES ($1, $2, $3, $4, $5)
    `, [proposalId, walletAddress, telegramId, commitment, votingPower]);
  }

  console.log(`🔒 Commitment recorded: ${walletAddress} for ${proposalId}`);
  return { success: true, proposalId, commitment };
}

/**
 * Reveal a vote (Tier 2/3 - reveal phase)
 */
async function revealVote(proposalId, walletAddress, voteChoice, salt) {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (!proposal.commitReveal) throw new Error('This proposal does not use commit-reveal');

  const now = Date.now();
  if (now < proposal.votingEnds.getTime()) throw new Error('Reveal phase has not started');
  if (now > proposal.revealEnds.getTime()) throw new Error('Reveal phase has ended');

  const proposalCommits = commitments.get(proposalId);
  const commit = proposalCommits.get(walletAddress);
  if (!commit) throw new Error('No commitment found for this wallet');

  // Verify commitment
  const crypto = require('crypto');
  const expectedCommitment = crypto
    .createHash('sha256')
    .update(`${voteChoice}:${salt}`)
    .digest('hex');

  if (commit.commitment !== expectedCommitment) {
    throw new Error('Invalid reveal: commitment does not match');
  }

  // Record the revealed vote
  return recordVote(proposalId, walletAddress, voteChoice, commit.votingPower, commit.telegramId);
}

/**
 * Resolve a proposal (called after voting/reveal ends)
 */
async function resolveProposal(proposalId) {
  const proposal = proposals.get(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status === 'resolved') return proposal;

  const totalStaked = staking.getTotalStaked();
  const totalSupply = config.token.currentSupply;

  // Check quorum (% of staked supply voted)
  const quorumMet = proposal.totalVotes >= (totalStaked * proposal.quorumRequired);

  // Check approval (% of total supply approved)
  const approvalMet = proposal.approveVotes >= (totalSupply * proposal.approvalRequired);

  let result;
  if (!quorumMet) {
    result = 'no_quorum';
  } else if (approvalMet) {
    result = 'approved';
  } else {
    result = 'denied';
  }

  proposal.status = 'resolved';
  proposal.result = result;
  proposal.resolvedAt = new Date();

  // Save to DB
  const client = db.getClient();
  if (client) {
    await client.query(`
      UPDATE governance_proposals 
      SET status = 'resolved', resolved_at = NOW()
      WHERE id = $1
    `, [proposalId]);
  }

  console.log(`📊 Proposal resolved: ${proposalId} -> ${result}`);
  console.log(`   Quorum: ${quorumMet} (${proposal.totalVotes}/${totalStaked * proposal.quorumRequired})`);
  console.log(`   Approval: ${approvalMet} (${proposal.approveVotes}/${totalSupply * proposal.approvalRequired})`);

  return proposal;
}

/**
 * Schedule proposal status transitions
 */
function scheduleProposalTransitions(proposal) {
  const now = Date.now();

  // Schedule voting start
  if (proposal.votingStarts.getTime() > now) {
    setTimeout(() => {
      proposal.status = 'voting';
      console.log(`🗳️ Voting started: ${proposal.id}`);
    }, proposal.votingStarts.getTime() - now);
  }

  // Schedule voting end / reveal start
  setTimeout(() => {
    if (proposal.commitReveal) {
      proposal.status = 'revealing';
      console.log(`🔓 Reveal phase started: ${proposal.id}`);
    } else {
      resolveProposal(proposal.id);
    }
  }, proposal.votingEnds.getTime() - now);

  // Schedule reveal end (if commit-reveal)
  if (proposal.revealEnds) {
    setTimeout(() => {
      resolveProposal(proposal.id);
    }, proposal.revealEnds.getTime() - now);
  }
}

/**
 * Get proposal by ID
 */
function getProposal(proposalId) {
  return proposals.get(proposalId);
}

/**
 * List proposals with filters
 */
function listProposals({ status, tier, limit = 20 } = {}) {
  let results = Array.from(proposals.values());
  
  if (status) results = results.filter(p => p.status === status);
  if (tier) results = results.filter(p => p.tier === tier);
  
  return results
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Get votes for a proposal
 */
function getVotes(proposalId) {
  const proposalVotes = votes.get(proposalId);
  if (!proposalVotes) return [];
  return Array.from(proposalVotes.entries()).map(([wallet, vote]) => ({
    wallet,
    ...vote
  }));
}

/**
 * Helper: Convert DB row to proposal object
 */
function rowToProposal(row) {
  return {
    id: row.id,
    tier: row.tier,
    title: row.title,
    description: row.description,
    targetId: row.target_id,
    targetType: row.target_type,
    bountyHbar: parseFloat(row.bounty_hbar),
    creatorWallet: row.creator_wallet,
    creatorTelegram: row.creator_telegram,
    status: row.status,
    snapshotTime: row.snapshot_time,
    votingStarts: row.voting_starts,
    votingEnds: row.voting_ends,
    revealEnds: row.reveal_ends,
    quorumRequired: parseFloat(row.quorum_required),
    approvalRequired: parseFloat(row.approval_required),
    totalVotes: parseInt(row.total_votes),
    approveVotes: parseInt(row.approve_votes),
    denyVotes: parseInt(row.deny_votes),
    abstainVotes: parseInt(row.abstain_votes),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

module.exports = {
  initialize,
  createProposal,
  vote,
  commitVote,
  revealVote,
  resolveProposal,
  getProposal,
  listProposals,
  getVotes
};
