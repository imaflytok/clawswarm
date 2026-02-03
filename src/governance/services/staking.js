/**
 * Staking Service
 * Tracks $FLY token staking for governance voting power
 */

const config = require('../config');
const db = require('../../services/db');

// In-memory cache (synced from DB)
const stakes = new Map();  // wallet -> { amount, stakedAt, lockedUntil }

/**
 * Initialize staking tables
 */
async function initialize() {
  const client = db.getClient();
  if (!client) {
    console.log('⚠️ Staking: No DB client, using in-memory only');
    return;
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS governance_stakes (
        id SERIAL PRIMARY KEY,
        wallet_address VARCHAR(20) NOT NULL UNIQUE,
        telegram_id VARCHAR(50),
        amount BIGINT NOT NULL DEFAULT 0,
        staked_at TIMESTAMP,
        locked_until TIMESTAMP,
        phone_hash VARCHAR(64),
        account_age_verified BOOLEAN DEFAULT FALSE,
        voting_enabled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_stakes_telegram ON governance_stakes(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_stakes_voting ON governance_stakes(voting_enabled);
    `);
    console.log('✅ Staking tables initialized');

    // Load existing stakes into memory
    const result = await client.query('SELECT * FROM governance_stakes WHERE amount > 0');
    for (const row of result.rows) {
      stakes.set(row.wallet_address, {
        amount: Number(row.amount),
        stakedAt: row.staked_at,
        lockedUntil: row.locked_until,
        telegramId: row.telegram_id,
        votingEnabled: row.voting_enabled
      });
    }
    console.log(`📊 Loaded ${stakes.size} active stakes`);
  } catch (e) {
    console.error('Staking init error:', e.message);
  }
}

/**
 * Link wallet to Telegram account
 */
async function linkWallet(walletAddress, telegramId, phoneHash = null) {
  // Check if wallet already linked
  const existing = await getStakeByWallet(walletAddress);
  if (existing && existing.telegramId && existing.telegramId !== telegramId) {
    throw new Error('Wallet already linked to another Telegram account');
  }

  // Check if Telegram already linked to another wallet
  const existingTg = await getStakeByTelegram(telegramId);
  if (existingTg && existingTg.walletAddress !== walletAddress) {
    throw new Error('Telegram account already linked to another wallet');
  }

  // Check phone hash limit (max 2 accounts per phone)
  if (phoneHash) {
    const phoneCount = await countByPhoneHash(phoneHash);
    if (phoneCount >= config.sybil.phoneAccountLimit) {
      throw new Error(`Phone number already linked to ${config.sybil.phoneAccountLimit} accounts`);
    }
  }

  const client = db.getClient();
  if (client) {
    await client.query(`
      INSERT INTO governance_stakes (wallet_address, telegram_id, phone_hash, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (wallet_address) 
      DO UPDATE SET telegram_id = $2, phone_hash = COALESCE($3, governance_stakes.phone_hash), updated_at = NOW()
    `, [walletAddress, telegramId, phoneHash]);
  }

  stakes.set(walletAddress, {
    ...stakes.get(walletAddress),
    telegramId,
    phoneHash,
    linkedAt: new Date()
  });

  return { success: true, walletAddress, telegramId };
}

/**
 * Record a stake (called after verifying on-chain transfer)
 */
async function recordStake(walletAddress, amount) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + config.staking.minStakeDuration);
  
  const existing = stakes.get(walletAddress) || {};
  const newAmount = (existing.amount || 0) + amount;

  const client = db.getClient();
  if (client) {
    await client.query(`
      UPDATE governance_stakes 
      SET amount = $1, staked_at = $2, locked_until = $3, updated_at = NOW()
      WHERE wallet_address = $4
    `, [newAmount, now, lockedUntil, walletAddress]);
  }

  stakes.set(walletAddress, {
    ...existing,
    amount: newAmount,
    stakedAt: now,
    lockedUntil
  });

  // Enable voting after cooldown (7 days from link, not stake)
  scheduleVotingEnable(walletAddress);

  return { 
    success: true, 
    walletAddress, 
    amount: newAmount, 
    lockedUntil 
  };
}

/**
 * Request unstake (checks lock period)
 */
async function requestUnstake(walletAddress, amount) {
  const stake = stakes.get(walletAddress);
  if (!stake) {
    throw new Error('No stake found for wallet');
  }

  if (stake.amount < amount) {
    throw new Error(`Insufficient staked balance. Have: ${stake.amount}, requested: ${amount}`);
  }

  if (stake.lockedUntil && new Date() < new Date(stake.lockedUntil)) {
    const remaining = Math.ceil((new Date(stake.lockedUntil) - new Date()) / (1000 * 60 * 60 * 24));
    throw new Error(`Stake locked for ${remaining} more days`);
  }

  // Check for active votes
  // TODO: Check if wallet has active commitments in any proposal

  const newAmount = stake.amount - amount;
  
  const client = db.getClient();
  if (client) {
    await client.query(`
      UPDATE governance_stakes SET amount = $1, updated_at = NOW()
      WHERE wallet_address = $2
    `, [newAmount, walletAddress]);
  }

  stakes.set(walletAddress, { ...stake, amount: newAmount });

  return { 
    success: true, 
    walletAddress, 
    unstaked: amount, 
    remaining: newAmount 
  };
}

/**
 * Get voting power for a wallet
 */
function getVotingPower(walletAddress) {
  const stake = stakes.get(walletAddress);
  if (!stake || !stake.votingEnabled) return 0;

  // Check 7-day stake lock requirement
  if (!stake.stakedAt) return 0;
  const stakeDuration = Date.now() - new Date(stake.stakedAt).getTime();
  if (stakeDuration < config.staking.minStakeDuration) return 0;

  // Apply 15% cap per wallet group
  const totalStaked = getTotalStaked();
  const maxPower = totalStaked * config.sybil.walletGroupCap;
  
  return Math.min(stake.amount, maxPower);
}

/**
 * Get total staked supply
 */
function getTotalStaked() {
  let total = 0;
  for (const stake of stakes.values()) {
    if (stake.amount > 0) total += stake.amount;
  }
  return total;
}

/**
 * Get all stakers with voting power
 */
function getActiveStakers() {
  const active = [];
  for (const [wallet, stake] of stakes.entries()) {
    const power = getVotingPower(wallet);
    if (power > 0) {
      active.push({ wallet, ...stake, votingPower: power });
    }
  }
  return active;
}

/**
 * Get stake by wallet
 */
async function getStakeByWallet(walletAddress) {
  return stakes.get(walletAddress);
}

/**
 * Get stake by Telegram ID
 */
async function getStakeByTelegram(telegramId) {
  for (const [wallet, stake] of stakes.entries()) {
    if (stake.telegramId === telegramId) {
      return { walletAddress: wallet, ...stake };
    }
  }
  return null;
}

/**
 * Count accounts by phone hash
 */
async function countByPhoneHash(phoneHash) {
  const client = db.getClient();
  if (!client) return 0;
  
  const result = await client.query(
    'SELECT COUNT(*) FROM governance_stakes WHERE phone_hash = $1',
    [phoneHash]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Schedule voting enable after cooldown
 */
function scheduleVotingEnable(walletAddress) {
  // In production, this would be a proper job scheduler
  setTimeout(async () => {
    const stake = stakes.get(walletAddress);
    if (stake) {
      stake.votingEnabled = true;
      stakes.set(walletAddress, stake);
      
      const client = db.getClient();
      if (client) {
        await client.query(
          'UPDATE governance_stakes SET voting_enabled = TRUE WHERE wallet_address = $1',
          [walletAddress]
        );
      }
      console.log(`✅ Voting enabled for ${walletAddress}`);
    }
  }, config.sybil.linkCooldown);
}

/**
 * Get staking stats
 */
function getStats() {
  const totalStaked = getTotalStaked();
  const activeStakers = getActiveStakers();
  
  return {
    totalStaked,
    totalStakers: stakes.size,
    activeVoters: activeStakers.length,
    averageStake: stakes.size > 0 ? totalStaked / stakes.size : 0,
    percentStaked: (totalStaked / config.token.currentSupply) * 100
  };
}

module.exports = {
  initialize,
  linkWallet,
  recordStake,
  requestUnstake,
  getVotingPower,
  getTotalStaked,
  getActiveStakers,
  getStakeByWallet,
  getStakeByTelegram,
  getStats
};
