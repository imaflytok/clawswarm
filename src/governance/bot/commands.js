/**
 * Telegram Bot Commands for Governance
 * Handles /gov, /stake, /vote, /propose commands
 */

const crypto = require('crypto');
const config = require('../config');
const staking = require('../services/staking');
const proposals = require('../services/proposals');

/**
 * Generate help text
 */
function getHelpText() {
  return `🏛️ **ClawSwarm Governance** ($FLY)

**Staking Commands:**
\`/gov link <wallet>\` - Link your Hedera wallet
\`/gov stake\` - Check your stake & voting power
\`/gov stats\` - View governance statistics

**Voting Commands:**
\`/gov proposals\` - List active proposals
\`/gov view <id>\` - View proposal details
\`/gov vote <id> approve|deny|abstain\` - Cast your vote

**Proposal Commands:**
\`/gov propose <title>\` - Create a new proposal

**Info:**
Token: $FLY (${config.token.id})
Min stake: ${config.staking.minStakeAmount} $FLY
Lock period: 7 days

Need help? Ask in #governance`;
}

/**
 * Parse governance command
 */
function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  const command = parts[1]?.toLowerCase();
  const args = parts.slice(2);
  return { command, args };
}

/**
 * Handle /gov command
 */
async function handleGovCommand(telegramId, username, text) {
  const { command, args } = parseCommand(text);

  switch (command) {
    case 'help':
    case undefined:
      return getHelpText();

    case 'link':
      return handleLink(telegramId, args[0]);

    case 'stake':
      return handleStakeInfo(telegramId);

    case 'stats':
      return handleStats();

    case 'proposals':
      return handleListProposals();

    case 'view':
      return handleViewProposal(args[0]);

    case 'vote':
      return handleVote(telegramId, args[0], args[1]);

    case 'propose':
      return handlePropose(telegramId, args.join(' '));

    default:
      return `Unknown command: ${command}\n\nUse \`/gov help\` for available commands.`;
  }
}

/**
 * Link wallet to Telegram
 */
async function handleLink(telegramId, walletAddress) {
  if (!walletAddress) {
    return `❌ Usage: \`/gov link <wallet>\`

Example: \`/gov link 0.0.12345\`

Your wallet must hold $FLY tokens to participate in governance.`;
  }

  // Validate wallet format
  if (!/^0\.0\.\d+$/.test(walletAddress)) {
    return `❌ Invalid wallet format. Use Hedera format: \`0.0.XXXXX\``;
  }

  try {
    await staking.linkWallet(walletAddress, telegramId.toString());
    
    return `✅ **Wallet Linked!**

Wallet: \`${walletAddress}\`
Telegram: ${telegramId}

**Next steps:**
1. Transfer $FLY to this wallet
2. Stake using the governance dApp (coming soon)
3. Wait 7 days for voting to activate

Your voting power will be based on your staked $FLY balance.`;
  } catch (e) {
    return `❌ ${e.message}`;
  }
}

/**
 * Get stake info for user
 */
async function handleStakeInfo(telegramId) {
  const stake = await staking.getStakeByTelegram(telegramId.toString());
  
  if (!stake) {
    return `❌ No linked wallet found.

Use \`/gov link <wallet>\` to link your Hedera wallet first.`;
  }

  const votingPower = staking.getVotingPower(stake.walletAddress);
  const totalStaked = staking.getTotalStaked();
  const powerPercent = totalStaked > 0 ? (votingPower / totalStaked * 100).toFixed(2) : 0;

  return `📊 **Your Governance Status**

**Wallet:** \`${stake.walletAddress}\`
**Staked:** ${stake.amount?.toLocaleString() || 0} $FLY
**Voting Power:** ${votingPower.toLocaleString()} (${powerPercent}%)
**Status:** ${stake.votingEnabled ? '✅ Active' : '⏳ Pending (7-day cooldown)'}

${stake.lockedUntil ? `**Locked until:** ${new Date(stake.lockedUntil).toLocaleDateString()}` : ''}`;
}

/**
 * Get governance stats
 */
async function handleStats() {
  const stats = staking.getStats();
  const activeProposals = proposals.listProposals({ status: 'voting' });

  return `📊 **Governance Statistics**

**Token:** $FLY (${config.token.id})
**Total Staked:** ${stats.totalStaked.toLocaleString()} $FLY
**% of Supply:** ${stats.percentStaked.toFixed(2)}%
**Total Stakers:** ${stats.totalStakers}
**Active Voters:** ${stats.activeVoters}
**Active Proposals:** ${activeProposals.length}

**Tiers:**
• Fast-track (<${config.tier1.maxBounty} HBAR): 24h voting, 3% approval
• Standard (${config.tier1.maxBounty}-${config.tier2.maxBounty} HBAR): 3d voting, 5% approval
• High-stakes (>${config.tier2.maxBounty} HBAR): 7d voting, 7% approval`;
}

/**
 * List active proposals
 */
async function handleListProposals() {
  const active = proposals.listProposals({ limit: 10 });
  
  if (active.length === 0) {
    return `📋 **No Active Proposals**

Create one with: \`/gov propose <title>\``;
  }

  let text = `📋 **Active Proposals**\n\n`;
  
  for (const p of active) {
    const timeLeft = getTimeLeft(p.votingEnds);
    const approvePercent = p.totalVotes > 0 
      ? (p.approveVotes / p.totalVotes * 100).toFixed(0) 
      : 0;
    
    text += `**${p.id}** - ${p.title}\n`;
    text += `└ ${p.tier} | ${p.status} | ${approvePercent}% approve | ${timeLeft}\n\n`;
  }

  text += `\nView details: \`/gov view <id>\``;
  return text;
}

/**
 * View proposal details
 */
async function handleViewProposal(proposalId) {
  if (!proposalId) {
    return `❌ Usage: \`/gov view <proposal_id>\``;
  }

  const proposal = proposals.getProposal(proposalId);
  if (!proposal) {
    return `❌ Proposal not found: ${proposalId}`;
  }

  const totalStaked = staking.getTotalStaked();
  const totalSupply = config.token.currentSupply;
  const quorumNeeded = totalStaked * proposal.quorumRequired;
  const approvalNeeded = totalSupply * proposal.approvalRequired;
  const quorumPercent = quorumNeeded > 0 ? (proposal.totalVotes / quorumNeeded * 100).toFixed(0) : 0;
  const approvalPercent = approvalNeeded > 0 ? (proposal.approveVotes / approvalNeeded * 100).toFixed(0) : 0;

  return `📋 **Proposal: ${proposal.id}**

**Title:** ${proposal.title}
**Tier:** ${proposal.tier}
**Status:** ${proposal.status}
**Bounty:** ${proposal.bountyHbar || 0} HBAR

**Description:**
${proposal.description || 'No description'}

**Voting Progress:**
• Total votes: ${proposal.totalVotes.toLocaleString()} / ${quorumNeeded.toLocaleString()} (${quorumPercent}% quorum)
• Approve: ${proposal.approveVotes.toLocaleString()} / ${approvalNeeded.toLocaleString()} needed (${approvalPercent}%)
• Deny: ${proposal.denyVotes.toLocaleString()}
• Abstain: ${proposal.abstainVotes.toLocaleString()}

**Timeline:**
• Voting ends: ${proposal.votingEnds.toLocaleString()}
${proposal.revealEnds ? `• Reveal ends: ${proposal.revealEnds.toLocaleString()}` : ''}

**Vote:** \`/gov vote ${proposal.id} approve|deny|abstain\``;
}

/**
 * Cast a vote
 */
async function handleVote(telegramId, proposalId, voteChoice) {
  if (!proposalId || !voteChoice) {
    return `❌ Usage: \`/gov vote <proposal_id> approve|deny|abstain\``;
  }

  const stake = await staking.getStakeByTelegram(telegramId.toString());
  if (!stake) {
    return `❌ No linked wallet. Use \`/gov link <wallet>\` first.`;
  }

  try {
    const result = await proposals.vote(proposalId, stake.walletAddress, voteChoice, telegramId.toString());
    
    return `✅ **Vote Recorded!**

Proposal: ${proposalId}
Your vote: **${voteChoice.toUpperCase()}**
Voting power: ${result.votingPower.toLocaleString()} $FLY

Total votes: ${result.totalVotes.toLocaleString()}`;
  } catch (e) {
    return `❌ ${e.message}`;
  }
}

/**
 * Create a proposal
 */
async function handlePropose(telegramId, title) {
  if (!title || title.length < 10) {
    return `❌ Usage: \`/gov propose <title>\`

Title must be at least 10 characters.

Example: \`/gov propose Fund marketing campaign for Q2\``;
  }

  const stake = await staking.getStakeByTelegram(telegramId.toString());
  if (!stake) {
    return `❌ No linked wallet. Use \`/gov link <wallet>\` first.`;
  }

  try {
    const proposal = await proposals.createProposal({
      title,
      creatorWallet: stake.walletAddress,
      creatorTelegram: telegramId.toString(),
      bountyHbar: 0  // Default to Tier 1
    });

    return `✅ **Proposal Created!**

ID: \`${proposal.id}\`
Title: ${proposal.title}
Tier: ${proposal.tier}

**Voting starts:** ${proposal.votingStarts.toLocaleString()}
**Voting ends:** ${proposal.votingEnds.toLocaleString()}

Share this with the community to gather votes!`;
  } catch (e) {
    return `❌ ${e.message}`;
  }
}

/**
 * Helper: Get human-readable time left
 */
function getTimeLeft(endDate) {
  const now = Date.now();
  const end = new Date(endDate).getTime();
  const diff = end - now;
  
  if (diff <= 0) return 'ended';
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h left`;
  return `${hours}h left`;
}

module.exports = {
  handleGovCommand,
  getHelpText
};
