/**
 * Server-Side Commit-Reveal
 * Abstracts cryptographic complexity for better UX
 * 
 * User just types: /vote prop_123 approve
 * We handle: salt generation, commitment, storage, auto-reveal
 */

const crypto = require('crypto');
const db = require('../../services/db');

// In-memory pending reveals (synced to DB)
const pendingReveals = new Map(); // proposalId -> Map(wallet -> {vote, salt, revealAt})

/**
 * Create a commitment for a vote
 * Returns the commitment hash and stores the secret for later reveal
 */
async function createCommitment(proposalId, walletAddress, voteChoice, revealTime) {
  // Generate cryptographically secure salt
  const salt = crypto.randomBytes(32).toString('hex');
  
  // Compute commitment: sha256(vote:salt)
  const commitment = crypto
    .createHash('sha256')
    .update(`${voteChoice}:${salt}`)
    .digest('hex');
  
  // Store for auto-reveal
  if (!pendingReveals.has(proposalId)) {
    pendingReveals.set(proposalId, new Map());
  }
  
  pendingReveals.get(proposalId).set(walletAddress, {
    vote: voteChoice,
    salt,
    commitment,
    revealAt: revealTime,
    createdAt: new Date()
  });
  
  // Persist to DB
  const client = db.getClient();
  if (client) {
    try {
      await client.query(`
        INSERT INTO governance_pending_reveals 
        (proposal_id, wallet_address, vote_encrypted, salt_encrypted, commitment, reveal_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (proposal_id, wallet_address) DO UPDATE 
        SET vote_encrypted = $3, salt_encrypted = $4, commitment = $5, reveal_at = $6
      `, [
        proposalId, 
        walletAddress,
        encrypt(voteChoice),  // Encrypted vote
        encrypt(salt),        // Encrypted salt
        commitment,
        new Date(revealTime)
      ]);
    } catch (e) {
      console.error('Failed to persist pending reveal:', e.message);
    }
  }
  
  console.log(`🔐 Commitment created: ${walletAddress} for ${proposalId}`);
  
  return {
    commitment,
    revealAt: new Date(revealTime)
  };
}

/**
 * Get pending reveal for a wallet
 */
function getPendingReveal(proposalId, walletAddress) {
  const proposalReveals = pendingReveals.get(proposalId);
  if (!proposalReveals) return null;
  return proposalReveals.get(walletAddress);
}

/**
 * Execute auto-reveal for a proposal
 * Called when reveal phase starts
 */
async function executeAutoReveals(proposalId, revealVoteFn) {
  const proposalReveals = pendingReveals.get(proposalId);
  if (!proposalReveals) {
    console.log(`No pending reveals for ${proposalId}`);
    return { revealed: 0, failed: 0 };
  }
  
  let revealed = 0;
  let failed = 0;
  
  for (const [walletAddress, data] of proposalReveals) {
    try {
      await revealVoteFn(proposalId, walletAddress, data.vote, data.salt);
      revealed++;
      console.log(`✅ Auto-revealed: ${walletAddress} -> ${data.vote}`);
    } catch (e) {
      failed++;
      console.error(`❌ Auto-reveal failed for ${walletAddress}:`, e.message);
    }
  }
  
  // Clear pending reveals
  pendingReveals.delete(proposalId);
  
  // Clean up DB
  const client = db.getClient();
  if (client) {
    try {
      await client.query(
        'DELETE FROM governance_pending_reveals WHERE proposal_id = $1',
        [proposalId]
      );
    } catch (e) {
      console.error('Failed to clean up pending reveals:', e.message);
    }
  }
  
  console.log(`📊 Auto-reveal complete: ${revealed} revealed, ${failed} failed`);
  return { revealed, failed };
}

/**
 * Initialize pending reveals table and load from DB
 */
async function initialize() {
  const client = db.getClient();
  if (!client) return;
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS governance_pending_reveals (
        id SERIAL PRIMARY KEY,
        proposal_id VARCHAR(50) NOT NULL,
        wallet_address VARCHAR(20) NOT NULL,
        vote_encrypted TEXT NOT NULL,
        salt_encrypted TEXT NOT NULL,
        commitment VARCHAR(66) NOT NULL,
        reveal_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(proposal_id, wallet_address)
      );
      
      CREATE INDEX IF NOT EXISTS idx_reveals_proposal ON governance_pending_reveals(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_reveals_time ON governance_pending_reveals(reveal_at);
    `);
    
    // Load pending reveals
    const result = await client.query(
      'SELECT * FROM governance_pending_reveals WHERE reveal_at > NOW()'
    );
    
    for (const row of result.rows) {
      if (!pendingReveals.has(row.proposal_id)) {
        pendingReveals.set(row.proposal_id, new Map());
      }
      pendingReveals.get(row.proposal_id).set(row.wallet_address, {
        vote: decrypt(row.vote_encrypted),
        salt: decrypt(row.salt_encrypted),
        commitment: row.commitment,
        revealAt: row.reveal_at.getTime(),
        createdAt: row.created_at
      });
    }
    
    console.log(`🔐 Loaded ${result.rows.length} pending reveals`);
  } catch (e) {
    console.error('Server commit-reveal init error:', e.message);
  }
}

// Simple encryption (for demo - use proper encryption in production)
const ENCRYPTION_KEY = process.env.GOVERNANCE_ENCRYPTION_KEY || 'default-dev-key-change-in-prod';

function encrypt(text) {
  // In production, use proper AES-256-GCM encryption
  // For now, simple base64 encoding (NOT SECURE - demo only)
  return Buffer.from(text).toString('base64');
}

function decrypt(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

module.exports = {
  createCommitment,
  getPendingReveal,
  executeAutoReveals,
  initialize
};
