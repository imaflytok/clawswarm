/**
 * Governance Configuration
 * ClawSwarm $FLY Token Governance
 */

module.exports = {
  // Token Configuration
  token: {
    id: '0.0.8012032',
    symbol: 'FLY',
    decimals: 8,
    currentSupply: 750_000_000,
    maxSupply: 1_000_000_000
  },

  // Network
  network: process.env.HEDERA_NETWORK || 'mainnet',
  
  // Staking Parameters
  staking: {
    minStakeAmount: 100,              // Minimum 100 $FLY to stake
    minStakeDuration: 7 * 24 * 60 * 60 * 1000,  // 7 days in ms
    unstakeCooldown: 7 * 24 * 60 * 60 * 1000,   // 7 days cooldown
  },

  // Tier 1: Fast-Track (small tasks)
  tier1: {
    name: 'fast-track',
    maxBounty: 100,                   // Max 100 HBAR
    proposerReputation: 50,           // Need 50+ rep to propose
    snapshotDelay: 0,                 // Immediate
    votingWindow: 24 * 60 * 60 * 1000,  // 24 hours
    revealWindow: 0,                  // No commit-reveal
    quorum: 0.05,                     // 5% of staked supply
    approval: 0.03,                   // 3% of total supply
    commitReveal: false
  },

  // Tier 2: Standard (medium tasks)
  tier2: {
    name: 'standard',
    maxBounty: 1000,                  // Max 1000 HBAR
    proposerStake: 1000,              // Need 1000 $FLY staked
    snapshotDelay: 24 * 60 * 60 * 1000,  // 24 hours
    votingWindow: 72 * 60 * 60 * 1000,   // 72 hours (3 days)
    revealWindow: 24 * 60 * 60 * 1000,   // 24 hours
    quorum: 0.10,                     // 10% of staked supply
    approval: 0.05,                   // 5% of total supply
    commitReveal: true
  },

  // Tier 3: High-Stakes (large tasks, parameter changes)
  tier3: {
    name: 'high-stakes',
    proposerStake: 10000,             // Need 10000 $FLY staked
    snapshotDelay: 72 * 60 * 60 * 1000,  // 72 hours
    votingWindow: 7 * 24 * 60 * 60 * 1000,  // 7 days
    revealWindow: 48 * 60 * 60 * 1000,    // 48 hours
    quorum: 0.15,                     // 15% of staked supply
    approval: 0.07,                   // 7% of total supply
    superMajority: 0.10,              // 10% for parameter changes
    commitReveal: true
  },

  // Sybil Resistance
  sybil: {
    phoneAccountLimit: 2,             // Max 2 accounts per phone
    telegramAgeMin: 30 * 24 * 60 * 60 * 1000,  // 30 days
    linkCooldown: 7 * 24 * 60 * 60 * 1000,     // 7 days before voting
    walletGroupCap: 0.15              // 15% max per wallet group
  },

  // Rewards
  rewards: {
    bountyFee: 0.01,                  // 1% of bounty releases
    minVotersForRewards: 10           // Minimum voters to distribute
  },

  // Guardian System
  guardians: {
    count: 9,
    threshold: 5,                     // 5-of-9 to pause
    pauseDurationMax: 24 * 60 * 60 * 1000,  // 24 hours max
    pauseCooldown: 30 * 24 * 60 * 60 * 1000  // 30 days between pauses
  },

  // Treasury (for collecting fees)
  treasury: {
    accountId: process.env.GOVERNANCE_TREASURY || '0.0.10176974'
  }
};
