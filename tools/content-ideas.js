#!/usr/bin/env node
/**
 * Content Ideas Generator
 * Generate social media content ideas based on Hedera data
 * 
 * Usage: node content-ideas.js [--platform twitter|discord|telegram]
 */

const https = require('https');

const MIRROR_NODE = 'mainnet.mirrornode.hedera.com';
const FLY_TOKEN = '0.0.8012032';

// Fetch JSON
function fetch(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Get HBAR price (mock - would need real API)
async function getHbarPrice() {
  // In production, use CoinGecko or similar
  return { price: 0.09, change24h: 2.5 };
}

// Get $FLY stats
async function getFlyStats() {
  const token = await fetch(MIRROR_NODE, `/api/v1/tokens/${FLY_TOKEN}`);
  const holders = await fetch(MIRROR_NODE, `/api/v1/tokens/${FLY_TOKEN}/balances?limit=20&order=desc`);
  
  const decimals = token.decimals || 8;
  const supply = parseInt(token.total_supply) / Math.pow(10, decimals);
  const activeHolders = holders.balances.filter(b => b.balance > 0).length;
  
  return {
    supply,
    maxSupply: 1000000000,
    holders: activeHolders,
    treasury: token.treasury_account_id
  };
}

// Get network stats
async function getNetworkStats() {
  const supply = await fetch(MIRROR_NODE, '/api/v1/network/supply');
  return {
    totalSupply: supply.total_supply,
    circulatingSupply: supply.released_supply
  };
}

// Content templates
const templates = {
  twitter: {
    priceUpdate: (hbar) => 
      `$HBAR update: $${hbar.price.toFixed(4)} (${hbar.change24h > 0 ? '+' : ''}${hbar.change24h.toFixed(1)}%)\n\nQuiet market = building time.\n\n#Hedera #HBAR`,
    
    flyStats: (fly) =>
      `$FLY Token Snapshot 🪰\n\n` +
      `Supply: ${(fly.supply/1e6).toFixed(0)}M / ${(fly.maxSupply/1e6).toFixed(0)}M max\n` +
      `Holders: ${fly.holders}\n\n` +
      `Part of the @OnlyFliesBuzz ecosystem on #Hedera`,
    
    buildingThread: () =>
      `🧵 What we shipped this week:\n\n` +
      `1/ Governance system with $FLY token voting\n` +
      `2/ Agent coordination platform (ClawSwarm)\n` +
      `3/ Real-time whale monitoring\n\n` +
      `Building in public on #Hedera. More coming.`,
    
    whyHedera: () =>
      `Why build on Hedera?\n\n` +
      `• Fixed, predictable fees ($0.0001/tx)\n` +
      `• 10k+ TPS, 3-5s finality\n` +
      `• Native token service (HTS)\n` +
      `• Enterprise adoption (Google, IBM, etc)\n\n` +
      `The quiet giant of crypto. #HBAR`,
    
    agentCoordination: () =>
      `AI agents need coordination layers.\n\n` +
      `ClawSwarm provides:\n` +
      `- Task marketplace with escrow\n` +
      `- Reputation system\n` +
      `- Token governance ($FLY)\n` +
      `- Real-time messaging\n\n` +
      `The future is multi-agent. 🤖`
  },
  
  discord: {
    dailyBrief: (hbar, fly) =>
      `📊 **Daily Brief**\n\n` +
      `**HBAR:** $${hbar.price.toFixed(4)} (${hbar.change24h > 0 ? '📈' : '📉'} ${hbar.change24h.toFixed(1)}%)\n` +
      `**$FLY Holders:** ${fly.holders}\n` +
      `**Supply:** ${(fly.supply/1e6).toFixed(1)}M / 1B\n\n` +
      `_Data from Hedera Mirror Node_`,
    
    projectUpdate: () =>
      `🔧 **Project Update**\n\n` +
      `**This week:**\n` +
      `✅ Token governance deployed\n` +
      `✅ Whale monitoring live\n` +
      `✅ Agent onboarding docs\n\n` +
      `**Next:**\n` +
      `- First governance proposal\n` +
      `- HBAR escrow for bounties\n` +
      `- More agent integrations`,
    
    dataInsight: (fly) =>
      `📈 **$FLY Insight**\n\n` +
      `Holder distribution:\n` +
      `• Top 2 wallets: ~60% (likely LP)\n` +
      `• Active holders: ${fly.holders}\n` +
      `• Supply used: ${(fly.supply/fly.maxSupply*100).toFixed(1)}%\n\n` +
      `Concentration is normal for new tokens. Distribution will improve with usage.`
  },
  
  telegram: {
    quickUpdate: (hbar) =>
      `🔔 Quick Update\n\n` +
      `HBAR: $${hbar.price.toFixed(4)}\n` +
      `Market: ${hbar.change24h > 0 ? 'Green' : 'Red'}\n\n` +
      `Building continues regardless. 🔨`,
    
    announcement: () =>
      `🚀 New: Governance Dashboard\n\n` +
      `View $FLY governance at:\n` +
      `onlyflies.buzz/clawswarm/governance.html\n\n` +
      `• Active proposals\n` +
      `• Staking stats\n` +
      `• Token info\n\n` +
      `Vote via @clawswarm_gov_bot`
  }
};

// Generate ideas
async function generateIdeas(platform = 'twitter') {
  console.log(`\n🎨 Content Ideas for ${platform.toUpperCase()}\n`);
  console.log('='.repeat(50));
  
  const hbar = await getHbarPrice();
  const fly = await getFlyStats();
  
  const platformTemplates = templates[platform] || templates.twitter;
  
  let i = 1;
  for (const [name, template] of Object.entries(platformTemplates)) {
    console.log(`\n--- Idea ${i}: ${name} ---\n`);
    
    let content;
    if (typeof template === 'function') {
      // Check what params the function needs
      const fnStr = template.toString();
      if (fnStr.includes('hbar') && fnStr.includes('fly')) {
        content = template(hbar, fly);
      } else if (fnStr.includes('hbar')) {
        content = template(hbar);
      } else if (fnStr.includes('fly')) {
        content = template(fly);
      } else {
        content = template();
      }
    } else {
      content = template;
    }
    
    console.log(content);
    console.log(`\n[${content.length} chars]`);
    i++;
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(`Generated ${i-1} content ideas for ${platform}`);
}

// CLI
const args = process.argv.slice(2);
let platform = 'twitter';

const platformIdx = args.indexOf('--platform');
if (platformIdx !== -1 && args[platformIdx + 1]) {
  platform = args[platformIdx + 1].toLowerCase();
}

if (args.includes('--all')) {
  (async () => {
    for (const p of ['twitter', 'discord', 'telegram']) {
      await generateIdeas(p);
    }
  })();
} else {
  generateIdeas(platform);
}
