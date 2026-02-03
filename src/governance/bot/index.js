/**
 * ClawSwarm Governance Telegram Bot
 * Handles staking, voting, and proposal commands
 */

const { Telegraf } = require('telegraf');
const config = require('../config');
const staking = require('../services/staking');
const proposals = require('../services/proposals');
const serverCommitReveal = require('../services/server-commit-reveal');

// Bot instance
let bot = null;

/**
 * Initialize the Telegram bot
 */
function initialize(token) {
  if (!token) {
    console.log('⚠️ No TELEGRAM_BOT_TOKEN, governance bot disabled');
    return null;
  }

  bot = new Telegraf(token);

  // Middleware: log all messages
  bot.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`[Gov Bot] ${ctx.updateType} processed in ${ms}ms`);
  });

  // ============ Commands ============

  // /start - Welcome message
  bot.start((ctx) => {
    ctx.reply(`🏛️ *ClawSwarm Governance Bot*

Welcome! I help you participate in $FLY token governance.

*Commands:*
/link <wallet> - Link your Hedera wallet
/stake - Check your stake status
/vote <proposal_id> <approve|deny|abstain> - Vote on a proposal
/proposals - List active proposals
/proposal <id> - View proposal details
/stats - Governance statistics
/help - Show this help

*Getting Started:*
1. Link your wallet with /link
2. Transfer $FLY to the staking escrow
3. Wait 7 days for voting to enable
4. Vote on proposals!

Token: $FLY (${config.token.id})`, { parse_mode: 'Markdown' });
  });

  // /help - Show commands
  bot.help((ctx) => {
    ctx.reply(`🏛️ *Governance Commands*

*Staking:*
/link <wallet> - Link Hedera wallet to Telegram
/stake - View your stake and voting power
/unstake <amount> - Request unstake (7-day cooldown)

*Voting:*
/proposals - List active proposals
/proposal <id> - View proposal details
/vote <id> <approve|deny|abstain> - Cast your vote

*Info:*
/stats - Governance statistics
/tiers - Explain voting tiers
/help - This message

*Need help?* Ask in @ima_fly`, { parse_mode: 'Markdown' });
  });

  // /link <wallet> - Link wallet to Telegram
  bot.command('link', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const walletAddress = args[0];

    if (!walletAddress) {
      return ctx.reply('Usage: /link <wallet_address>\n\nExample: /link 0.0.12345');
    }

    // Validate wallet format (basic check)
    if (!/^0\.0\.\d+$/.test(walletAddress)) {
      return ctx.reply('❌ Invalid wallet format. Use: 0.0.XXXXX');
    }

    try {
      const result = await staking.linkWallet(
        walletAddress,
        ctx.from.id.toString(),
        null // Phone hash added later via verification
      );

      ctx.reply(`✅ *Wallet Linked!*

Wallet: \`${walletAddress}\`
Telegram: @${ctx.from.username || ctx.from.id}

*Next Steps:*
1. Transfer $FLY to escrow: \`${config.treasury.accountId}\`
2. Include memo: \`stake:${ctx.from.id}\`
3. Wait 7 days for voting power

Your stake will be detected automatically.`, { parse_mode: 'Markdown' });
    } catch (e) {
      ctx.reply(`❌ ${e.message}`);
    }
  });

  // /stake - Check stake status
  bot.command('stake', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    
    try {
      const stake = await staking.getStakeByTelegram(telegramId);
      
      if (!stake) {
        return ctx.reply(`❌ No wallet linked.

Use /link <wallet> to get started.`);
      }

      const votingPower = staking.getVotingPower(stake.walletAddress);
      const lockedUntil = stake.lockedUntil ? new Date(stake.lockedUntil).toLocaleDateString() : 'N/A';

      ctx.reply(`📊 *Your Stake*

Wallet: \`${stake.walletAddress}\`
Staked: ${stake.amount?.toLocaleString() || 0} $FLY
Voting Power: ${votingPower.toLocaleString()} $FLY
Locked Until: ${lockedUntil}
Voting Enabled: ${stake.votingEnabled ? '✅' : '⏳ (7-day cooldown)'}

${!stake.votingEnabled ? '_Your voting power activates 7 days after linking._' : ''}`, { parse_mode: 'Markdown' });
    } catch (e) {
      ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  // /proposals - List active proposals
  bot.command('proposals', async (ctx) => {
    const list = proposals.listProposals({ status: 'voting', limit: 10 });

    if (list.length === 0) {
      return ctx.reply('📋 No active proposals right now.\n\nCheck back later or create one!');
    }

    let msg = '📋 *Active Proposals*\n\n';
    for (const p of list) {
      const timeLeft = Math.max(0, Math.ceil((new Date(p.votingEnds) - Date.now()) / (1000 * 60 * 60)));
      msg += `*${p.id}* (${p.tier})\n`;
      msg += `${p.title}\n`;
      msg += `⏰ ${timeLeft}h left | 👍 ${p.approveVotes} 👎 ${p.denyVotes}\n\n`;
    }
    msg += '_Use /vote <id> <approve|deny> to vote_';

    ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // /proposal <id> - View proposal details
  bot.command('proposal', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const proposalId = args[0];

    if (!proposalId) {
      return ctx.reply('Usage: /proposal <proposal_id>');
    }

    const proposal = proposals.getProposal(proposalId);
    if (!proposal) {
      return ctx.reply('❌ Proposal not found');
    }

    const timeLeft = Math.max(0, Math.ceil((new Date(proposal.votingEnds) - Date.now()) / (1000 * 60 * 60)));
    const totalVotes = proposal.approveVotes + proposal.denyVotes + proposal.abstainVotes;

    ctx.reply(`📋 *Proposal ${proposal.id}*

*${proposal.title}*
${proposal.description || '_No description_'}

*Tier:* ${proposal.tier}
*Bounty:* ${proposal.bountyHbar} HBAR
*Status:* ${proposal.status}

*Voting:*
👍 Approve: ${proposal.approveVotes.toLocaleString()}
👎 Deny: ${proposal.denyVotes.toLocaleString()}
🤷 Abstain: ${proposal.abstainVotes.toLocaleString()}
📊 Total: ${totalVotes.toLocaleString()}

*Requirements:*
Quorum: ${(proposal.quorumRequired * 100).toFixed(1)}%
Approval: ${(proposal.approvalRequired * 100).toFixed(1)}%

⏰ *${timeLeft}h remaining*

_Vote: /vote ${proposal.id} approve|deny|abstain_`, { parse_mode: 'Markdown' });
  });

  // /vote <proposal_id> <choice> - Cast vote
  bot.command('vote', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const proposalId = args[0];
    const voteChoice = args[1]?.toLowerCase();

    if (!proposalId || !voteChoice) {
      return ctx.reply('Usage: /vote <proposal_id> <approve|deny|abstain>');
    }

    if (!['approve', 'deny', 'abstain'].includes(voteChoice)) {
      return ctx.reply('❌ Vote must be: approve, deny, or abstain');
    }

    const telegramId = ctx.from.id.toString();
    
    try {
      // Get linked wallet
      const stake = await staking.getStakeByTelegram(telegramId);
      if (!stake) {
        return ctx.reply('❌ No wallet linked. Use /link <wallet> first.');
      }

      if (!stake.votingEnabled) {
        return ctx.reply('⏳ Voting not enabled yet. Wait for 7-day cooldown after linking.');
      }

      const votingPower = staking.getVotingPower(stake.walletAddress);
      if (votingPower === 0) {
        return ctx.reply('❌ No voting power. Stake $FLY and wait 7 days.');
      }

      // Get proposal to check if commit-reveal needed
      const proposal = proposals.getProposal(proposalId);
      if (!proposal) {
        return ctx.reply('❌ Proposal not found');
      }

      let result;
      let message;
      const emoji = voteChoice === 'approve' ? '👍' : voteChoice === 'deny' ? '👎' : '🤷';

      if (proposal.commitReveal) {
        // Tier 2/3: Server-side commit-reveal
        const revealTime = new Date(proposal.votingEnds).getTime();
        const commitData = await serverCommitReveal.createCommitment(
          proposalId, 
          stake.walletAddress, 
          voteChoice, 
          revealTime
        );
        
        // Submit commitment to proposals service
        await proposals.commitVote(proposalId, stake.walletAddress, commitData.commitment, telegramId);
        
        const revealDate = commitData.revealAt.toLocaleDateString();
        message = `${emoji} *Vote Committed!*

Proposal: ${proposalId}
Vote: 🔒 HIDDEN (until reveal)
Power: ${votingPower.toLocaleString()} $FLY

_Your vote will be revealed automatically on ${revealDate}._
_This is Tier ${proposal.tier.slice(-1)} voting with commit-reveal._`;
      } else {
        // Tier 1: Direct voting
        result = await proposals.vote(proposalId, stake.walletAddress, voteChoice, telegramId);
        message = `${emoji} *Vote Recorded!*

Proposal: ${proposalId}
Vote: ${voteChoice.toUpperCase()}
Power: ${votingPower.toLocaleString()} $FLY

_Vote counted immediately (Tier 1 fast-track)._`;
      }

      ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (e) {
      ctx.reply(`❌ ${e.message}`);
    }
  });

  // /stats - Governance statistics
  bot.command('stats', async (ctx) => {
    const stats = staking.getStats();
    const activeProposals = proposals.listProposals({ status: 'voting' });

    ctx.reply(`📊 *Governance Stats*

*Staking:*
Total Staked: ${stats.totalStaked?.toLocaleString() || 0} $FLY
Stakers: ${stats.stakerCount || 0}
Avg Stake: ${stats.avgStake?.toLocaleString() || 0} $FLY

*Proposals:*
Active: ${activeProposals.length}
Total: ${stats.totalProposals || 0}

*Token:*
$FLY: ${config.token.id}
Supply: ${config.token.currentSupply.toLocaleString()}

_Governance docs: github.com/imaflytok/clawswarm_`, { parse_mode: 'Markdown' });
  });

  // /tiers - Explain voting tiers
  bot.command('tiers', (ctx) => {
    ctx.reply(`🏛️ *Voting Tiers*

*Tier 1: Fast-Track* ⚡
• Tasks ≤100 HBAR
• 24h voting window
• Direct voting (no reveal)
• 5% quorum, 3% approval

*Tier 2: Standard* 📋
• Tasks ≤1000 HBAR
• 72h voting + 24h reveal
• Commit-reveal voting
• 10% quorum, 5% approval

*Tier 3: High-Stakes* 🔒
• Tasks >1000 HBAR
• 7 day voting + 48h reveal
• Commit-reveal voting
• 15% quorum, 7% approval

_Higher stakes = more scrutiny_`, { parse_mode: 'Markdown' });
  });

  // Error handler
  bot.catch((err, ctx) => {
    console.error('[Gov Bot] Error:', err);
    ctx.reply('❌ Something went wrong. Try again later.');
  });

  return bot;
}

/**
 * Start the bot (polling mode)
 */
async function start(token) {
  const b = initialize(token);
  if (!b) return;

  await b.launch();
  console.log('🤖 Governance bot started');

  // Graceful shutdown
  process.once('SIGINT', () => b.stop('SIGINT'));
  process.once('SIGTERM', () => b.stop('SIGTERM'));
}

/**
 * Get bot instance for webhook mode
 */
function getBot() {
  return bot;
}

module.exports = {
  initialize,
  start,
  getBot
};
